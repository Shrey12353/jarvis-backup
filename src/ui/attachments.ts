/**
 * Attachment handling for the web UI — zero dependencies.
 *
 * A browser uploads files as multipart/form-data. We parse it ourselves,
 * save files safely under the workspace (data/uploads), extract what the
 * agent can actually read:
 *   - images (jpg/png/webp/gif) → base64 for a vision model, if configured
 *   - pdf                        → extracted text (own tiny parser)
 *   - text-ish files             → read as UTF-8 text
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { confineToWorkspace } from "../core/config.js";

export const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);
const TEXT_EXT = new Set([".txt", ".md", ".csv", ".json", ".log", ".yaml", ".yml", ".xml", ".html", ".js", ".ts", ".py", ".css"]);
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export interface UploadedFile {
  fieldName: string;
  filename: string;
  data: Buffer;
}

/**
 * Parse multipart/form-data into fields + files. Enough for browsers:
 * walks the boundary-delimited parts; does not aim to be a general
 * multipart library. Only used for same-origin local requests.
 */
export function parseMultipart(body: Buffer, contentType: string): { fields: Record<string, string>; files: UploadedFile[] } {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) throw new Error("multipart boundary missing");
  const boundary = "--" + (m[1] ?? m[2]).trim();
  const fields: Record<string, string> = {};
  const files: UploadedFile[] = [];
  const bBoundary = Buffer.from(boundary);
  let pos = body.indexOf(bBoundary);
  while (pos !== -1) {
    const next = body.indexOf(bBoundary, pos + bBoundary.length);
    if (next === -1) break;
    // Part spans from after this boundary line (skip boundary + CRLF) to before the next boundary's preceding CRLF.
    const partStart = pos + bBoundary.length + 2;
    const part = body.subarray(partStart, next - 2);
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) { pos = next; continue; }
    const headerText = part.subarray(0, headerEnd).toString("utf8");
    const data = part.subarray(headerEnd + 4);
    const nameM = /name="([^"]*)"/i.exec(headerText);
    const fileM = /filename="([^"]*)"/i.exec(headerText);
    if (fileM) {
      files.push({ fieldName: nameM?.[1] ?? "file", filename: fileM[1] || "upload.bin", data });
    } else if (nameM) {
      fields[nameM[1]] = data.toString("utf8");
    }
    pos = next;
  }
  return { fields, files };
}

export function extnameSafe(filename: string): string {
  return path.extname(filename).toLowerCase();
}

/** Public description of an attachment for the message the agent sees. */
export interface AttachmentInfo {
  name: string;
  kind: "image" | "pdf" | "text";
  path: string; // workspace-relative
  chars?: number; // for text/pdf
  note?: string; // extraction warning, if any
  excerpt?: string; // first chunk of extracted text, so the model never has to open files
}

const EXCERPT_LEN = 6_000;

/**
 * Compose the context block that goes INTO the user's message: names, kinds,
 * and (for text/pdf) the actual first chunk of content. With this in the
 * conversation the model can answer directly and never needs to ask the user
 * for file paths.
 */
export function composeAttachmentContext(infos: AttachmentInfo[], visionNote: string | null): string {
  const lines: string[] = [];
  for (const s of infos) {
    if (s.kind === "image") {
      lines.push(`[Attached image: ${s.name}]`);
      if (visionNote) lines.push(`[Image content: ${visionNote}]`);
    } else if (s.kind === "pdf" || (s.kind === "text" && s.excerpt)) {
      lines.push(`[Attached ${s.kind}: ${s.name}${s.note ? ` — ${s.note}` : ""}]`, `[Content of ${s.name}:`, s.excerpt ?? "", "]");
    } else {
      lines.push(`[Attached file: ${s.name} — saved at ${s.path}${s.note ? "; " + s.note : ""}]`);
    }
  }
  return lines.join("\n");
}

export function isImageFile(filename: string): boolean {
  return IMAGE_EXT.has(extnameSafe(filename));
}

/**
 * Detect junk extractions: styled PDFs (Canva/Word/design tools) encode text
 * in ways the tiny parser can't read, producing font-name spam like repeated
 * "Adobe UCS". Feeding that to the model is worse than admitting failure.
 */
export function looksLikeGarbage(text: string): boolean {
  if (text.trim().length < 40) return true;
  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  if (letters / Math.max(1, text.length) < 0.15) return true; // symbol soup
  const lines = text.split(/\n+/).map((s) => s.trim()).filter((s) => s.length > 3);
  if (lines.length >= 6) {
    const freq = new Map<string, number>();
    for (const l of lines) freq.set(l, (freq.get(l) ?? 0) + 1);
    const top = Math.max(...freq.values());
    if (top / lines.length > 0.4) return true; // >40% identical lines = spam
  }
  return false;
}

// ---- Smart PDF fallback: real PDF reader (pdf.js) inside Playwright Chromium ----
// Handles the modern font encodings the tiny parser can't. The pdf.js scripts
// are cached on disk after the first use, so this also works offline later.

const PDFJS_CDNS = [
  ["https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js", "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"],
  ["https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js", "https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js"],
] as const;

async function ensurePdfJs(): Promise<{ lib: string; worker: string } | null> {
  const dir = path.join(process.cwd(), "data", "cache");
  const libPath = path.join(dir, "pdf.min.js");
  const workerPath = path.join(dir, "pdf.worker.min.js");
  try {
    return { lib: await fsp.readFile(libPath, "utf8"), worker: await fsp.readFile(workerPath, "utf8") };
  } catch {
    /* need to download */
  }
  for (const [libUrl, workerUrl] of PDFJS_CDNS) {
    try {
      const get = async (u: string): Promise<string> => {
        const r = await fetch(u, { signal: AbortSignal.timeout(15_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      };
      const lib = await get(libUrl);
      const worker = await get(workerUrl);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(libPath, lib, "utf8");
      await fsp.writeFile(workerPath, worker, "utf8");
      return { lib, worker };
    } catch {
      /* try next mirror */
    }
  }
  return null;
}

type PdfJs = {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (o: { data: Uint8Array }) => { promise: Promise<PdfDoc> };
};
type PdfDoc = { numPages: number; getPage: (n: number) => Promise<PdfPage> };
type PdfPage = { getTextContent: () => Promise<{ items: Array<{ str?: string }> }> };

/** Extract text with the real pdf.js reader in a throwaway headless Chromium. */
export async function extractPdfTextViaBrowser(buf: Buffer, maxPages = 40): Promise<string | null> {
  const assets = await ensurePdfJs();
  if (!assets) return null;
  let browser: import("playwright").Browser | null = null;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.addScriptTag({ content: assets.lib });
    const text: string = await page.evaluate(async ({ b64, worker, maxPages }) => {
      const pdfjsLib = (window as unknown as { pdfjsLib: PdfJs }).pdfjsLib;
      const workerUrl = URL.createObjectURL(new Blob([worker], { type: "application/javascript" }));
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
      const parts: string[] = [];
      const n = Math.min(doc.numPages, maxPages);
      for (let p = 1; p <= n; p++) {
        const pg = await doc.getPage(p);
        const tc = await pg.getTextContent();
        parts.push(tc.items.map((it) => it.str ?? "").join(" "));
      }
      return parts.join("\n\n");
    }, { b64: buf.toString("base64"), worker: assets.worker, maxPages });
    return text.trim() || null;
  } catch {
    return null;
  } finally {
    await browser?.close().catch(() => {});
  }
}

function safeUploadPath(workspace: string, filename: string): string | null {
  // Strip directory components from client filenames; confine result to workspace.
  const base = path.basename(filename).replace(/[^\w.\- ()]+/g, "_") || "upload.bin";
  return confineToWorkspace(path.join("data", "uploads", base), workspace);
}

/** Extract readable text from a PDF buffer (FlateDecode/TXT streams). */
export function extractPdfText(buf: Buffer, maxLen = 20_000): { text: string; truncated: boolean } {
  const chunks: string[] = [];
  const raw = buf.toString("latin1");
  const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(raw)) && chunks.join("").length < maxLen) {
    const chunk = m[1];
    let decoded: string | null = null;
    // Only the very common uncompressed and zlib cases; other filters are skipped.
    try {
      decoded = inflateSync(Buffer.from(chunk, "latin1")).toString("latin1");
    } catch {
      decoded = chunk; // maybe plain text stream
    }
    const text = extractPdfTextFromContent(decoded);
    if (text) chunks.push(text);
  }
  let text = chunks.join("\n").replace(/[ \t]+/g, " ").trim();
  const truncated = text.length > maxLen;
  if (truncated) text = text.slice(0, maxLen);
  if (!text) text = "(no extractable text — likely a scanned/image PDF)";
  return { text, truncated };
}

/** Pull parenthesized text-show operators out of a PDF content stream. */
function extractPdfTextFromContent(content: string): string {
  const out: string[] = [];
  const re = /\((?:\\.|[^\\()])*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const lit = m[0].slice(1, -1);
    const unescaped = lit.replace(/\\([()\\])/g, "$1").replace(/\\n/g, " ").replace(/\\r/g, " ").replace(/\\t/g, " ");
    if (unescaped.trim()) out.push(unescaped);
  }
  return out.join(" ");
}

/** Save one upload; returns the info the agent will see. */
export async function saveUpload(
  file: UploadedFile,
  workspace: string
): Promise<AttachmentInfo> {
  if (file.data.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${file.filename} is larger than 20 MB`);
  }
  if (!file.data.length) throw new Error(`${file.filename} is empty`);
  const abs = safeUploadPath(workspace, file.filename);
  if (!abs) throw new Error("upload path escapes the workspace");
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, file.data);

  const rel = path.relative(workspace, abs).replace(/\\/g, "/");
  const ext = extnameSafe(file.filename);
  if (isImageFile(file.filename)) {
    return { name: file.filename, kind: "image", path: rel };
  }
  if (ext === ".pdf") {
    let { text, truncated } = extractPdfText(file.data);
    let smart = false;
    if (looksLikeGarbage(text)) {
      // Tiny parser produced junk (styled/encoded PDF) — try the real reader.
      const better = await extractPdfTextViaBrowser(file.data);
      if (better && !looksLikeGarbage(better)) {
        text = better;
        truncated = better.length > 20_000;
        smart = true;
      } else {
        text = "(this PDF uses a non-standard encoding — no readable text could be extracted; it is likely scanned images or designer-made)";
        truncated = false;
      }
    }
    const txtPath = abs.replace(/\.pdf$/i, ".txt");
    await fsp.writeFile(txtPath, text, "utf8");
    return {
      name: file.filename,
      kind: "pdf",
      path: rel,
      chars: text.length,
      note: /^\(this PDF|^\(no extractable text/.test(text)
        ? (smart ? undefined : "unreadable PDF — no machine-readable text inside")
        : smart ? "read with the smart PDF reader"
        : truncated ? "long document — first part included here, full text at " + path.relative(workspace, txtPath).replace(/\\/g, "/")
        : undefined,
      excerpt: text.slice(0, EXCERPT_LEN),
    };
  }
  // Everything else: try UTF-8 text when the extension says so or it decodes cleanly.
  const looksText = TEXT_EXT.has(ext) || isProbablyText(file.data);
  if (!looksText) {
    return { name: file.filename, kind: "text", path: rel, note: "saved as binary — Jarvis can inspect it with tools" };
  }
  const text = file.data.toString("utf8");
  return {
    name: file.filename,
    kind: "text",
    path: rel,
    chars: text.length,
    note: text.length > 20_000 ? "long file — first part included here, saved at " + rel : undefined,
    excerpt: text.slice(0, EXCERPT_LEN),
  };
}

function isProbablyText(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 4_096));
  let suspicious = 0;
  for (const b of sample) if (b === 0 || (b < 9 && b !== 0) || (b > 13 && b < 32)) suspicious++;
  return suspicious / Math.max(1, sample.length) < 0.01;
}
