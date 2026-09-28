import { run } from "../core/proc.js";
import type { Tool } from "./types.js";

export const vscodeTools: Tool[] = [
  {
    name: "vscode_open",
    description: "Open a file or folder in VS Code via the `code` CLI. Creates a new window if requested.",
    safety: "auto",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "File or folder path (default: workspace)" },
        new_window: { type: "boolean", description: "Open in new window" },
      },
    },
    async run(args, ctx) {
      const target = (args.target as string) || ctx.cfg.agent.workspace || process.cwd();
      const r = await run(`code ${args.new_window ? "-n" : ""} "${target}"`, { timeoutMs: 20_000 });
      return r.code === 0 ? `Opened ${target} in VS Code` : `code CLI failed: ${(r.stderr || r.stdout).trim()}`;
    },
  },
  {
    name: "vscode_cmd",
    description: "Run a VS Code CLI subcommand: ext install <id>, ext list, ext remove <id>, --version.",
    safety: "ask",
    parameters: {
      type: "object",
      properties: {
        subcommand: { type: "string", description: "e.g. 'ext install esbenp.prettier-vscode'" },
      },
      required: ["subcommand"],
    },
    async run(args) {
      const r = await run(`code ${String(args.subcommand)}`, { timeoutMs: 120_000 });
      return r.code === 0 ? r.stdout.trim() || "OK" : `code CLI failed: ${(r.stderr || r.stdout).trim()}`;
    },
  },
];
