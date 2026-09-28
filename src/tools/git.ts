import { run } from "../core/proc.js";
import type { Tool, ToolContext } from "./types.js";

function fmt(r: { stdout: string; stderr: string; code: number | null; timedOut: boolean }): string {
  const parts: string[] = [];
  if (r.stdout.trim()) parts.push(r.stdout.trim());
  if (r.stderr.trim()) parts.push("STDERR:\n" + r.stderr.trim());
  parts.push(`[exit ${r.code ?? "null"}${r.timedOut ? " TIMED OUT" : ""}]`);
  return parts.join("\n").slice(0, 12_000);
}

async function gh(ctx: ToolContext, sub: string, timeoutMs = 120_000): Promise<string> {
  const cwd = ctx.cfg.agent.workspace || process.cwd();
  const r = await run(`gh ${sub}`, { cwd, timeoutMs });
  return fmt(r);
}

export const gitTools: Tool[] = [
  {
    name: "git_status",
    description: "Show git status, current branch, and recent commits in the workspace repo.",
    safety: "auto",
    parameters: { type: "object", properties: { path: { type: "string", description: "Repo path (default workspace)" } } },
    async run(args, ctx) {
      const cwd = (args.path as string) || ctx.cfg.agent.workspace || process.cwd();
      const s = await run(`git status --short --branch`, { cwd });
      const log = await run(`git log --oneline -10`, { cwd });
      return [fmt(s), "Recent commits:", fmt(log)].join("\n");
    },
  },
  {
    name: "git_commit",
    description: "Stage files and commit. Provide file paths (or '.' for all changes) and a message. Does NOT push.",
    safety: "ask",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo path (default workspace)" },
        files: { type: "string", description: "Files to stage ('.' for all)" },
        message: { type: "string", description: "Commit message" },
      },
      required: ["files", "message"],
    },
    async run(args, ctx) {
      const cwd = (args.path as string) || ctx.cfg.agent.workspace || process.cwd();
      const files = String(args.files || ".");
      const msg = String(args.message || "").replace(/"/g, '\\"');
      const add = await run(`git add ${files}`, { cwd });
      if (add.code !== 0) return fmt(add);
      const c = await run(`git commit -m "${msg}"`, { cwd });
      return fmt(c);
    },
  },
  {
    name: "git_push",
    description: "Push committed changes to the remote. Optional branch name.",
    safety: "ask",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo path" },
        branch: { type: "string", description: "Branch to push (default: current)" },
      },
    },
    async run(args, ctx) {
      const cwd = (args.path as string) || ctx.cfg.agent.workspace || process.cwd();
      const branch = args.branch ? String(args.branch) : "";
      const r = await run(branch ? `git push -u origin ${branch}` : `git push`, { cwd, timeoutMs: 180_000 });
      return fmt(r);
    },
  },
  {
    name: "github",
    description:
      "Run a GitHub CLI (gh) subcommand: pr list/create/merge, issue list/create, repo view, release, api, etc. Check 'gh auth status' first if unsure.",
    safety: "ask",
    parameters: {
      type: "object",
      properties: {
        subcommand: { type: "string", description: "e.g. 'pr create --title T --body B' or 'issue list'" },
      },
      required: ["subcommand"],
    },
    async run(args, ctx) {
      return gh(ctx, String(args.subcommand ?? ""));
    },
  },
];
