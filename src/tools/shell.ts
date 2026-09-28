import { run } from "../core/proc.js";
import { existsSync } from "node:fs";
import { confineToWorkspace } from "../core/config.js";
import type { Tool, ToolContext } from "./types.js";

/**
 * Resolve the shell cwd inside the workspace; refuse escapes (incl. "../..").
 * Also refuses folders that do not exist — Node reports a missing cwd as a
 * misleading "spawn cmd.exe ENOENT", which sends the model in circles.
 */
function confinedCwd(ctx: ToolContext, arg: unknown): string {
  const raw = (arg as string) || ctx.cfg.agent.workspace;
  const cwd = confineToWorkspace(raw, ctx.cfg.agent.workspace);
  if (!cwd) {
    throw new Error(
      `Refused: cwd escapes the workspace sandbox (${ctx.cfg.agent.workspace}). Run commands inside the workspace.`
    );
  }
  if (!existsSync(cwd)) {
    throw new Error(
      `Refused: the folder "${cwd}" does not exist. Create it first with the write_file tool (e.g. create <name>/.keep) or use list_dir on the workspace to see real folders.`
    );
  }
  return cwd;
}

/** Patterns we refuse outright, regardless of tier. The gate still asks before running anything in "ask" tier. */
const DENY: RegExp[] = [
  /\bdel\s+\/[sq]\s/i,
  /\brm\s+-rf?\s+\/(?:\s|$)/,
  /:\(\)\s*\{\s*:\|\:&\s*\};:/,
  /reg\s+add\s+.*HKLM/i,
  /vssadmin\s+delete\s+shadows/i,
  /bcdedit/i,
  /cipher\s+\/w/i,
  /mkfs/i,
  /dd\s+if=.*of=\/dev\/[sh]d[a-z]/i,
  /\bshutdown\b/i,
  /\brestart-computer\b/i,
  /\bformat\b\s+[a-z]:/i,
];

export function denyCheck(cmd: string): string | null {
  for (const re of DENY) {
    if (re.test(cmd)) return `command matches a protected pattern: ${re.source}`;
  }
  return null;
}

/**
 * Best-effort guard against commands that reach outside the workspace even
 * when cwd itself is confined (e.g. `move x.txt ../y.txt`, `cd .. && ...`,
 * or absolute destinations on other trees). A determined model can still
 * obfuscate paths (env vars, encoded chars) — for untrusted autonomy rely on
 * the "ask" tier or OS-level sandboxing; this is the cheap always-on floor.
 */
export function commandPathGuard(cmd: string, workspace: string): string | null {
  // 1. Any ".." path segment (cd .., ../x, ..\x, a/../../b)
  if (/(^|[\s"'^&|=])(\.\.)([\\/]|\s|$)/.test(cmd) || /\.\.[\\/]/.test(cmd)) {
    return "command contains '..' path traversal";
  }
  // 2. Mutating commands referencing absolute paths must stay in the workspace
  const mutating = /\b(move|copy|xcopy|robocopy|del|erase|rd|rmdir|mkdir|md|ren|rename|mv|cp|rm|touch|out-file)\b/i;
  if (mutating.test(cmd)) {
    const abs = cmd.match(/[A-Za-z]:[\\/][^\s"&|^]*/g) ?? [];
    for (const p of abs) {
      if (!confineToWorkspace(p, workspace)) {
        return `command references a path outside the workspace: ${p}`;
      }
    }
  }
  return null;
}

export const shellTool: Tool = {
  name: "shell",
  description:
    "Run a shell command on the PC (PowerShell/cmd on Windows, bash elsewhere). Use for builds, tests, installs, package scripts, and CLI tools. Captures stdout/stderr. Never use for interactive prompts.",
  safety: "ask",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run" },
      cwd: { type: "string", description: "Working directory (default: workspace)" },
      timeout_seconds: { type: "number", description: "Timeout in seconds (default 120, max 600)" },
    },
    required: ["command"],
  },
  async run(args, ctx) {
    const command = String(args.command ?? "");
    if (!command.trim()) return "Error: empty command";
    const deny = denyCheck(command);
    if (deny) return `Refused: ${deny}`;
    const pathGuard = commandPathGuard(command, ctx.cfg.agent.workspace);
    if (pathGuard) return `Refused: ${pathGuard}`;
    const cwd = confinedCwd(ctx, args.cwd);
    const timeoutMs = Math.min(Math.max(Number(args.timeout_seconds ?? 120), 1), 600) * 1000;
    const r = await run(command, { cwd, timeoutMs });
    const parts: string[] = [];
    if (r.stdout.trim()) parts.push(r.stdout.trim());
    if (r.stderr.trim()) parts.push("STDERR:\n" + r.stderr.trim());
    parts.push(`[exit ${r.code ?? "null"}${r.timedOut ? " TIMED OUT" : ""}]`);
    return parts.join("\n").slice(0, 16_000);
  },
};

export const safeShellTool: Tool = {
  name: "shell_readonly",
  description:
    "Run a read-only shell command (no state changes) without confirmation. Use for ls, cat, type, git status, git log, node -v, npm ls, dir, echo, which/where, systeminfo, etc. Anything that writes, installs, or deletes must use the shell tool.",
  safety: "auto",    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Read-only shell command" },
      cwd: { type: "string", description: "Working directory" },
    },
    required: ["command"],
  },
  async run(args, ctx) {
    const command = String(args.command ?? "").trim();
    if (!command) return "Error: empty command";
    const first = command.split(/\s+/)[0]?.toLowerCase() ?? "";
    const ok = [
      "dir", "ls", "cat", "type", "head", "tail", "wc", "echo", "pwd", "cd", "cd -", "tree",
      "git status", "git log", "git diff", "git branch", "git show", "git remote",
      "node", "npm", "npx", "pnpm", "yarn", "bun",
      "python", "pip", "where", "which", "whoami", "hostname", "systeminfo", "ver", "uname",
      "gh", "vercel", "supabase", "code",
    ].some((w) => first === w || command.toLowerCase().startsWith(w));
    // Even whitelisted commands cannot contain obviously mutating operators.
    const mutating = /(^|\s|&&|;|\|)(del|rm|mv|move|rmdir|rd|mkdir|md|git\s+(add|commit|push|reset|checkout\s+-b|clean)|npm\s+(i|install|uninstall|ci)|pip\s+install|vercel\s+|supabase\s+(db|functions|link|projects|login)|code\s+--install-ext)\b/i;
    if (!ok || mutating.test(command)) {
      return "Refused: not a recognized read-only command. Use the 'shell' tool for anything that changes state.";
    }
    const pathGuard = commandPathGuard(command, ctx.cfg.agent.workspace);
    if (pathGuard) return `Refused: ${pathGuard}`;
    const cwd = confinedCwd(ctx, args.cwd);
    const r = await run(command, { cwd, timeoutMs: 60_000 });
    const parts: string[] = [];
    if (r.stdout.trim()) parts.push(r.stdout.trim());
    if (r.stderr.trim()) parts.push("STDERR:\n" + r.stderr.trim());
    parts.push(`[exit ${r.code ?? "null"}]`);
    return parts.join("\n").slice(0, 16_000);
  },
};
