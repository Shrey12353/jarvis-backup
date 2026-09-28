/**
 * Image generation for Jarvis — no API key, no install.
 *
 * generate_image turns a description into a real PNG saved under
 * workspace/data/generated, then returns an IMAGES: block the web UI renders
 * as a gallery (same mechanism as generated product photos).
 *
 * Engine: Pollinations (free, keyless AI image service). The description is
 * sent to it to create the picture — the image itself is saved locally.
 * A fully-offline engine (Stable Diffusion via Ollama-compatible servers)
 * can be added later as another case in generateWithEngine().
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { confineToWorkspace } from "../core/config.js";
import type { Tool, ToolContext } from "./types.js";

const GEN_HOST = process.env.JARVIS_IMAGE_API || "https://image.pollinations.ai";

export interface GenImage {
  name: string;          // product/caption line
  image: string;         // URL the <img> tag uses — may be local: rel path
  source?: string;       // click-through link (omitted for local files)
}

/** Pure: build the Pollinations URL for a prompt. Exported for tests. */
export function buildImageUrl(prompt: string, opts: { width?: number; height?: number; seed?: number; model?: string } = {}): string {
  const q = new URLSearchParams({
    width: String(opts.width ?? 1024),
    height: String(opts.height ?? 1024),
    seed: String(opts.seed ?? Math.floor(Math.random() * 1_000_000)),
    nologo: "true",
  });
  if (opts.model) q.set("model", opts.model);
  return `${GEN_HOST}/prompt/${encodeURIComponent(prompt.slice(0, 600))}?${q.toString()}`;
}

/** Pure: the relay-safe block, local files included. Exported for tests. */
export function imagesBlockLocal(images: GenImage[]): string {
  if (!images.length) return "";
  return "\n\nIMAGES:\n" + images.map((i) => `PRODUCT: ${i.name}\nIMAGE_URL: ${i.image}`).join("\n");
}

/** Pure: tiny prompt doctor — adds style hints the small model forgets. */
export function polishPrompt(p: string): string {
  const base = p.replace(/\s+/g, " ").trim();
  if (!base) return "a beautiful detailed illustration";
  if (/style|photo|painting|illustration|render|art/i.test(base)) return base;
  return `${base}, detailed digital illustration, high quality`;
}

/** Sanitize a filename from the prompt. */
function safeName(prompt: string, ext: string): string {
  const base = prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "image";
  return `${base}-${Date.now().toString(36)}${ext}`;
}

/** Detect the real image format from magic bytes (services don't always honor the extension). */
export function detectImageExt(buf: Buffer): string {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";
  if (buf.length >= 6 && buf.toString("ascii", 0, 3) === "GIF") return ".gif";
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return ".webp";
  return ".jpg";
}

/** Generate one image with the configured engine. Throws on failure. */
export async function generateWithEngine(prompt: string, opts: { width?: number; height?: number; model?: string } = {}): Promise<Buffer> {
  const url = buildImageUrl(prompt, opts);
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`image service said HTTP ${res.status}`);
  const ct = res.headers.get("content-type") ?? "";
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || (ct && !/image\//i.test(ct))) throw new Error(`image service returned ${ct || "empty data"}`);
  return buf;
}

export const imageGenTools: Tool[] = [
  {
    name: "generate_image",
    description:
      "Create an image from a text description (AI image generation). Saves a PNG in the workspace and shows it to the user in the chat as a picture gallery. Use whenever the user asks to create, draw, generate, or imagine a picture/image/logo/poster. Always relay the IMAGES block the tool returns exactly as-is.",
    safety: "auto",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "A vivid English description of the image to create (subject, style, colors, mood)" },
        name: { type: "string", description: "Short caption shown under the picture (default: the prompt)" },
        width: { type: "number", description: "Pixels wide (default 1024)" },
        height: { type: "number", description: "Pixels tall (default 1024)" },
      },
      required: ["prompt"],
    },
    async run(args, ctx: ToolContext) {
      const prompt = String(args.prompt ?? "").trim();
      if (!prompt) return "Error: describe the image you want (prompt is required).";
      const caption = String(args.name ?? prompt).trim().slice(0, 80) || prompt.slice(0, 80);
      const width = Math.min(2048, Math.max(256, Number(args.width ?? 1024)));
      const height = Math.min(2048, Math.max(256, Number(args.height ?? 1024)));
      try {
        const buf = await generateWithEngine(polishPrompt(prompt), { width, height });
        const rel = confineToWorkspace(path.join("data", "generated", safeName(prompt, detectImageExt(buf))), ctx.cfg.agent.workspace);
        if (!rel) return "Error: workspace path invalid";
        await fsp.mkdir(path.dirname(rel), { recursive: true });
        await fsp.writeFile(rel, buf);
        return `Image created and saved (${(buf.length / 1024).toFixed(0)} KB) at ${path.relative(ctx.cfg.agent.workspace, rel).replace(/\\/g, "/")}.${imagesBlockLocal([{ name: caption, image: `local:${path.relative(ctx.cfg.agent.workspace, rel).replace(/\\/g, "/")}` }])}`;
      } catch (e) {
        return `Error: could not create the image — ${e instanceof Error ? e.message : String(e)}. The image service may be busy; try again or simplify the description.`;
      }
    },
  },
];
