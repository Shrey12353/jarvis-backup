import { promises as fs } from "node:fs";
import path from "node:path";
import { truncate } from "../core/util.js";
import { confineToWorkspace, resolveReadRoots, resolveReadablePath } from "../core/config.js";
import type { Tool, ToolContext } from "./types.js";

/** Resolve a tool path argument inside the workspace; refuse escapes. */
function resolvePath(ctx: ToolContext, p: string): string {
  const confined = confineToWorkspace(p, ctx.cfg.agent.workspace);
  if (!confined) {
    const roots = resolveReadRoots(ctx.cfg);
    throw new Error(
      `Refused: I can only WRITE inside my workspace (${ctx.cfg.agent.workspace}). ` +
        `To change a file from your own folders (${roots.join(", ") || "none"}), copy it into the workspace first. Reading them is allowed — use read_file/list_dir.`
    );
  }
  return confined;
}

/**
 * Reading is allowed in the workspace AND in the user's own folders (Downloads,
 * Desktop, Documents...), so "summarise the PDF in my Downloads" just works.
 */
function resolveReadPath(ctx: ToolContext, p: string): string {
  const abs = resolveReadablePath(p, ctx.cfg.agent.workspace, resolveReadRoots(ctx.cfg));
  if (!abs) {
    const roots = resolveReadRoots(ctx.cfg);
    throw new Error(
      `Refused: "${p}" is outside what I may read. I can read my workspace (${ctx.cfg.agent.workspace})` +
        (roots.length ? ` and your folders (${roots.join(", ")}).` : ".")
    );
  }
  return abs;
}

export const fsTools: Tool[] = [
  {
    name: "read_file",
    description:
      "Read a text file from disk. Works inside the workspace AND in the user's own folders (Downloads, Desktop, Documents, Pictures). Returns the full content (truncated to ~8k chars).",
    safety: "auto",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (relative to workspace or absolute)" },
        offset_line: { type: "number", description: "1-indexed line to start from (optional)" },
        limit_lines: { type: "number", description: "Max lines to read (optional)" },
      },
      required: ["path"],
    },
    async run(args, ctx) {
      const p = resolveReadPath(ctx, String(args.path));
      const text = await fs.readFile(p, "utf8");
      const lines = text.split(/\r?\n/);
      const off = Math.max(0, Number(args.offset_line ?? 1) - 1);
      const lim = Number(args.limit_lines ?? 400);
      const slice = lines.slice(off, off + lim).map((l, i) => `${off + i + 1}: ${l}`);
      return truncate(slice.join("\n"), 8_000) || "(empty file)";
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file with full content. Parent directories are created automatically.",
    safety: "ask",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to write" },
        content: { type: "string", description: "Complete file content" },
      },
      required: ["path", "content"],
    },
    async run(args, ctx) {
      const p = resolvePath(ctx, String(args.path));
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, String(args.content ?? ""), "utf8");
      return `Wrote ${p} (${String(args.content ?? "").length} chars)`;
    },
  },
  {
    name: "edit_file",
    description: "Replace an exact substring in a file. old_string must match exactly, including whitespace.",
    safety: "ask",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        old_string: { type: "string", description: "Exact text to replace" },
        new_string: { type: "string", description: "Replacement text" },
      },
      required: ["path", "old_string", "new_string"],
    },
    async run(args, ctx) {
      const p = resolvePath(ctx, String(args.path));
      const text = await fs.readFile(p, "utf8");
      const oldS = String(args.old_string);
      const n = text.split(oldS).length - 1;
      if (n === 0) return "Error: old_string not found in file";
      const next = n > 1 ? text.replace(oldS, String(args.new_string)) : text.replace(oldS, String(args.new_string));
      await fs.writeFile(p, next, "utf8");
      return `Edited ${p} (replaced ${n} occurrence${n > 1 ? "s" : ""})`;
    },
    // Note: replaces first occurrence only; model should split multi-edits into calls.
  },
  {
    name: "list_dir",
    description:
      "List files and folders in a directory (one level). Works in the workspace and in the user's own folders (Downloads, Desktop, Documents, Pictures).",
    safety: "auto",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path (default: workspace)" } },
    },
    async run(args, ctx) {
      const p = resolveReadPath(ctx, String(args.path ?? "."));
      const entries = await fs.readdir(p, { withFileTypes: true });
      const lines = entries.map((e) => (e.isDirectory() ? `[dir] ${e.name}` : `      ${e.name}`));
      return truncate(`${p}\n` + lines.join("\n"), 8_000) || "(empty)";
    },
  },
  {
    name: "search_files",
    description: "Search file contents with a regex. Returns matching lines with file:line.",
    safety: "auto",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern" },
        glob: { type: "string", description: "Optional filename glob like *.ts" },
        path: { type: "string", description: "Directory to search (default: workspace)" },
      },
      required: ["pattern"],
    },
    async run(args, ctx) {
      const { run: runCmd } = await import("../core/proc.js");
      const root = resolveReadPath(ctx, String(args.path ?? "."));
      const pat = String(args.pattern).replace(/"/g, '\\"');
      const glob = args.glob ? ` -g ${JSON.stringify(String(args.glob))}` : "";
      // Prefer ripgrep if installed; fallback to PowerShell findstr loop.
      const rg = await runCmd(`rg -n --hidden -g !node_modules${glob} "${pat}" .`, { cwd: root, timeoutMs: 30_000 });
      if (rg.code === 0 && rg.stdout.trim()) return truncate(rg.stdout.trim(), 8_000);
      const ps = `Get-ChildItem -Recurse -File ${
        args.glob ? `-Filter ${JSON.stringify(String(args.glob))}` : ""
      } | Select-String -Pattern "${pat}" | ForEach-Object { "$($_.Path):$($_.LineNumber): $($_.Line)" }`;
      const alt = await runCmd(ps, { cwd: root, timeoutMs: 60_000 });
      return truncate((alt.stdout || alt.stderr).trim() || "No matches", 8_000);
    },
  },
];
