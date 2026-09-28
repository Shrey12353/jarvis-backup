/**
 * Vision helper — describes images with the local vision model (moondream/llava).
 *
 * Two reasons this module exists:
 *  1. Attaching an image used to freeze the send button for ~30s while the CPU
 *     model read a full-resolution photo. We shrink the image first (a screen
 *     grab doesn't need to be 4K to be understood) and can describe it in the
 *     BACKGROUND, so the chat starts instantly.
 *  2. Screenshots of the user's own screen go through the same path.
 *
 * Nothing leaves the PC: the image goes to the local Ollama server only.
 */
import { promises as fsp, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runArgv } from "./proc.js";

const SCRIPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts");
const RESIZE_SCRIPT = path.join(SCRIPTS_DIR, "resize-image.ps1");

export interface VisionResult {
  text: string;
  error?: string;
  /** How long the description took (ms). */
  ms: number;
  /** The (possibly shrunk) file the model actually looked at. */
  usedPath: string;
}

type Job = { state: "pending" | "done"; result?: VisionResult; startedAt: number };

/** Finished results keyed by "path|mtime|size" so re-asking is instant. */
const cache = new Map<string, VisionResult>();
/** In-flight descriptions keyed by absolute path (dedupes the UI + tool paths). */
const inflight = new Map<string, Promise<VisionResult>>();
const jobs = new Map<string, Job>();

export function visionCacheDir(dataDir: string): string {
  return path.join(dataDir, "cache", "vision");
}

async function fileKey(absPath: string): Promise<string> {
  const st = await fsp.stat(absPath);
  return `${absPath}|${Math.round(st.mtimeMs)}|${st.size}`;
}

export function visionCached(absPath: string): VisionResult | null {
  for (const [k, v] of cache) {
    if (k.startsWith(absPath + "|")) return v;
  }
  return null;
}

export function visionJobState(absPath: string): Job | null {
  return jobs.get(absPath) ?? null;
}

/**
 * Downscale an image for the vision model (keeps aspect ratio, PNG out).
 * Falls back to the original file when PowerShell/System.Drawing is unavailable.
 */
export async function shrinkImage(absPath: string, outDir: string, maxDim = 1024): Promise<string> {
  try {
    await fsp.mkdir(outDir, { recursive: true });
    const base = path.basename(absPath).replace(/\.[^.]+$/, "");
    const out = path.join(outDir, `${base}-small.png`);
    // argv (no shell) — cmd.exe mangles the quotes around Windows paths.
    const r = await runArgv(
      ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", RESIZE_SCRIPT, absPath, out, String(maxDim)],
      { timeoutMs: 60_000 }
    );
    if (r.code === 0 && existsSync(out)) return out;
  } catch {
    /* fall through to the original */
  }
  return absPath;
}

/** Ask the vision model about one file (no shrinking, no caching). */
async function callVision(absPath: string, model: string, host: string, prompt: string): Promise<string> {
  const b64 = (await fsp.readFile(absPath)).toString("base64");
  const res = await fetch(`${host.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [{ role: "user", content: prompt, images: [b64] }],
      options: { temperature: 0.2 },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`vision model said HTTP ${res.status}`);
  const j = (await res.json()) as { message?: { content?: string } };
  return (j.message?.content ?? "").trim();
}

const DEFAULT_PROMPT =
  "Describe this image in detail for a blind assistant: objects, people, layout, any text (exact wording), numbers, and colors.";

/** Describe an image now (shrinking + caching). Never throws. */
export async function describeImageNow(
  absPath: string,
  model: string,
  host: string,
  opts: { dataDir?: string; maxDim?: number; prompt?: string } = {}
): Promise<VisionResult> {
  const started = Date.now();
  try {
    const key = await fileKey(absPath);
    const hit = cache.get(key);
    if (hit) return hit;
    const small = opts.dataDir ? await shrinkImage(absPath, visionCacheDir(opts.dataDir), opts.maxDim ?? 1024) : absPath;
    const text = await callVision(small, model, host, opts.prompt ?? DEFAULT_PROMPT);
    const result: VisionResult = { text: text || "(the vision model returned nothing)", ms: Date.now() - started, usedPath: small };
    cache.set(key, result);
    return result;
  } catch (e) {
    return { text: "", error: e instanceof Error ? e.message : String(e), ms: Date.now() - started, usedPath: absPath };
  }
}

/**
 * Start describing in the background (deduped by path). Returns the promise so
 * callers can either await it or let it run.
 */
export function describeImageInBackground(
  absPath: string,
  model: string,
  host: string,
  opts: { dataDir?: string; maxDim?: number; prompt?: string } = {}
): Promise<VisionResult> {
  const existing = inflight.get(absPath);
  if (existing) return existing;
  jobs.set(absPath, { state: "pending", startedAt: Date.now() });
  const p = describeImageNow(absPath, model, host, opts).then((r) => {
    jobs.set(absPath, { state: "done", result: r, startedAt: Date.now() });
    inflight.delete(absPath);
    return r;
  });
  inflight.set(absPath, p);
  return p;
}

/**
 * Wait up to `timeoutMs` for a description (starting one if needed).
 * `pending: true` means "not ready yet" — the caller should keep going and the
 * description will be available later via describe_image.
 */
export async function describeOrWait(
  absPath: string,
  model: string,
  host: string,
  timeoutMs: number,
  opts: { dataDir?: string; maxDim?: number; prompt?: string } = {}
): Promise<{ result: VisionResult | null; pending: boolean }> {
  const p = describeImageInBackground(absPath, model, host, opts);
  const timeout = new Promise<null>((res) => setTimeout(() => res(null), Math.max(0, timeoutMs)));
  const raced = await Promise.race([p, timeout]);
  if (raced) return { result: raced, pending: false };
  return { result: visionCached(absPath), pending: true };
}
