import path from "node:path";
import { promises as fsp, existsSync } from "node:fs";
import type { Tool, ToolContext } from "./types.js";
import { captureScreen, listOpenWindows, readClipboardText } from "../core/pc.js";
import { describeImageInBackground, describeOrWait, visionCached } from "../core/vision.js";
import { resolveReadRoots, resolveReadablePath } from "../core/config.js";

/** Workspace-relative, forward-slashed path the UI can render as an image. */
function relToWorkspace(cfg: { agent: { workspace: string } }, abs: string): string {
  return path.relative(cfg.agent.workspace, abs).split(path.sep).join("/");
}

function visionConfig(ctx: ToolContext): { model: string; host: string } | null {
  const model = (ctx.cfg.ollama.vision_model || "").trim();
  return model ? { model, host: ctx.cfg.ollama.host } : null;
}

/**
 * PC-awareness tools — what makes Jarvis feel like an assistant sitting at the
 * machine rather than a chat window: it can look at your screen, read what you
 * copied, and say what is open. All read-only, all local.
 */
export const pcTools: Tool[] = [
  {
    name: "read_clipboard",
    description:
      "Read whatever the user last copied (clipboard text). Use when they say \"this thing I copied\", \"fix what I copied\", or paste nothing but refer to copied text.",
    safety: "auto",
    parameters: { type: "object", properties: {} },
    async run(_args, ctx: ToolContext) {
      try {
        const text = await readClipboardText();
        if (!text) return "(the clipboard is empty, or it holds an image rather than text)";
        const capped = text.length > 6_000 ? text.slice(0, 6_000) + "\n…(truncated)" : text;
        return `Clipboard content:\n${capped}`;
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    name: "screenshot_screen",
    description:
      "Take a picture of the user's screen and read it with the vision model. Use whenever they ask about something on screen (an error, a page, a chart). Include the returned picture in your reply as ![screen](path).",
    safety: "auto",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "Optional: what to look for on screen (e.g. \"read the error message\")" },
      },
    },
    async run(args, ctx: ToolContext) {
      try {
        const abs = await captureScreen(ctx.cfg.agent.workspace);
        const rel = relToWorkspace(ctx.cfg, abs);
        const vision = visionConfig(ctx);
        if (!vision) {
          return `Screenshot saved as ${rel} (no vision model is configured, so I can't read it). Include ![screen](${rel}) in your reply and offer to install a vision model.`;
        }
        const q = String(args.question ?? "").trim();
        const prompt = q
          ? `The user asks about their screen: "${q}". Read the screen and answer precisely, quoting any visible text or error message exactly.`
          : undefined;
        const { result } = await describeOrWait(abs, vision.model, vision.host, 150_000, {
          dataDir: ctx.cfg.paths.data,
          maxDim: 1_200,
        });
        if (!result || result.error) {
          return `Screenshot saved as ${rel} but the vision model failed (${result?.error ?? "no answer"}). Include ![screen](${rel}) in your reply and tell the user the description failed.`;
        }
        return [`Screenshot saved as ${rel}.`, `What the screen shows: ${result.text}`, `Include ![screen](${rel}) in your reply so the user sees the capture.`].join("\n");
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    name: "list_windows",
    description: "List which windows/apps are currently open on the PC (app name + window title).",
    safety: "auto",
    parameters: { type: "object", properties: {} },
    async run(_args) {
      try {
        return await listOpenWindows();
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    name: "describe_image",
    description:
      "Look at an image file (an attachment, upload or screenshot) with the vision model and get a detailed description. Use when you need to check an image again, or when an image was still being read when it arrived.",
    safety: "auto",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Image path, workspace-relative (e.g. data/uploads/pic.png) or inside the user's folders" },
        question: { type: "string", description: "Optional: what to look for in the image" },
      },
      required: ["path"],
    },
    async run(args, ctx: ToolContext) {
      const rel = String(args.path ?? "").trim();
      const abs = resolveReadablePath(rel, ctx.cfg.agent.workspace, resolveReadRoots(ctx.cfg));
      if (!abs || !existsSync(abs)) return `Error: I can't find the image "${rel}".`;
      const vision = visionConfig(ctx);
      if (!vision) return "Error: no vision model is configured — offer to install one (ollama_pull with moondream).";
      const cached = visionCached(abs);
      const q = String(args.question ?? "").trim();
      if (cached?.text && !q) return cached.text;
      const p = q
        ? describeOrWait(abs, vision.model, vision.host, 180_000, { dataDir: ctx.cfg.paths.data, prompt: q }).then((r) => r.result)
        : describeImageInBackground(abs, vision.model, vision.host, { dataDir: ctx.cfg.paths.data }).then((r) => r);
      const res = await p;
      if (!res || res.error) return `Error: the vision model could not read that image (${res?.error ?? "no answer"}).`;
      return res.text;
    },
  },
  {
    name: "file_info",
    description: "Show basic details of any file the user can reach: size, modified time, and (for text) the first lines.",
    safety: "auto",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "File path (workspace-relative or in the user's folders)" } },
      required: ["path"],
    },
    async run(args, ctx: ToolContext) {
      const p = String(args.path ?? "").trim();
      const abs = resolveReadablePath(p, ctx.cfg.agent.workspace, resolveReadRoots(ctx.cfg));
      if (!abs) return `Error: "${p}" is outside what I may read.`;
      try {
        const st = await fsp.stat(abs);
        if (st.isDirectory()) return `${abs} is a folder.`;
        const size = st.size > 1024 * 1024 ? `${(st.size / 1024 / 1024).toFixed(1)} MB` : `${Math.round(st.size / 1024)} KB`;
        let head = "";
        if (/\.(txt|md|csv|json|log|ya?ml|xml|html?|js|ts|py|css)$/i.test(abs)) {
          head = "\n\nFirst lines:\n" + (await fsp.readFile(abs, "utf8")).slice(0, 800);
        }
        return `${abs}\nSize: ${size}\nModified: ${st.mtime.toLocaleString()}${head}`;
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
];
