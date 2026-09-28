import { run } from "../core/proc.js";
import type { Tool, ToolContext } from "./types.js";

function fmt(r: { stdout: string; stderr: string; code: number | null; timedOut: boolean }): string {
  const parts: string[] = [];
  if (r.stdout.trim()) parts.push(r.stdout.trim());
  if (r.stderr.trim()) parts.push("STDERR:\n" + r.stderr.trim());
  parts.push(`[exit ${r.code ?? "null"}${r.timedOut ? " TIMED OUT" : ""}]`);
  return parts.join("\n").slice(0, 12_000);
}

async function cli(ctx: ToolContext, cmd: string, timeoutMs = 180_000): Promise<string> {
  const cwd = ctx.cfg.agent.workspace || process.cwd();
  const r = await run(cmd, { cwd, timeoutMs });
  return fmt(r);
}

const VERCEL_LOGIN_HINT =
  "Not logged in to Vercel. Ask the user to run `vercel login` in a terminal (interactive), or set VERCEL_TOKEN.";

const SUPABASE_LOGIN_HINT =
  "Not logged in to Supabase. Ask the user to run `supabase login` (interactive) or set SUPABASE_ACCESS_TOKEN.";

async function vercelAuthed(ctx: ToolContext): Promise<boolean> {
  if (process.env.VERCEL_TOKEN) return true;
  const r = await run(`vercel whoami`, { cwd: ctx.cfg.agent.workspace || process.cwd(), timeoutMs: 30_000 });
  return r.code === 0 && !/not logged in/i.test(r.stdout + r.stderr);
}

async function supabaseAuthed(ctx: ToolContext): Promise<boolean> {
  if (process.env.SUPABASE_ACCESS_TOKEN) return true;
  const r = await run(`supabase projects list`, { cwd: ctx.cfg.agent.workspace || process.cwd(), timeoutMs: 60_000 });
  return r.code === 0 && !/not logged in|access token/i.test(r.stderr);
}

export const deployTools: Tool[] = [
  {
    name: "vercel_deploy",
    description:
      "Deploy a project to Vercel. Args: project_path (default workspace), prod (boolean, default false = preview), or run arbitrary `vercel` subcommands via subcommand arg (env add, logs, ls, rm...).",
    safety: "ask",
    parameters: {
      type: "object",
      properties: {
        project_path: { type: "string", description: "Path to the app to deploy (default: workspace)" },
        prod: { type: "boolean", description: "true = production deployment" },
        subcommand: { type: "string", description: "Optional: run `vercel <subcommand>` instead of deploying" },
      },
    },
    async run(args, ctx) {
      if (!(await vercelAuthed(ctx))) return VERCEL_LOGIN_HINT;
      const dir = (args.project_path as string) || ctx.cfg.agent.workspace || process.cwd();
      if (args.subcommand) {
        return cli(ctx, `vercel ${String(args.subcommand)}`, 120_000);
      }
      const cmd = args.prod ? `vercel --prod --yes` : `vercel --yes`;
      const r = await run(cmd, { cwd: dir, timeoutMs: 600_000 });
      const out = fmt(r);
      // Surface the deployment URL prominently for the model/user.
      const url = (r.stdout.match(/https:\/\/[^\s]+\.vercel\.app[^\s]*/i) || [])[0];
      return url ? `DEPLOYED: ${url}\n${out}` : out;
    },
  },
  {
    name: "vercel_status",
    description: "Check Vercel login status and list recent deployments for the linked project.",
    safety: "auto",
    parameters: { type: "object", properties: {} },
    async run(args, ctx) {
      const who = await run(`vercel whoami`, { cwd: ctx.cfg.agent.workspace || process.cwd(), timeoutMs: 30_000 });
      if (who.code !== 0) return `Vercel CLI not logged in (or not installed).\n${fmt(who)}\n${VERCEL_LOGIN_HINT}`;
      const ls = await run(`vercel ls`, { cwd: ctx.cfg.agent.workspace || process.cwd(), timeoutMs: 60_000 });
      return `whoami: ${who.stdout.trim()}\nDeployments:\n${fmt(ls)}`;
    },
  },
  {
    name: "supabase",
    description:
      "Run a Supabase CLI subcommand: projects list, link, db push, db diff, migration new, functions deploy, secrets set, status, etc.",
    safety: "ask",
    parameters: {
      type: "object",
      properties: {
        subcommand: { type: "string", description: "e.g. 'db push' or 'functions deploy serve'" },
        project_path: { type: "string", description: "Path containing supabase/ folder (default workspace)" },
      },
      required: ["subcommand"],
    },
    async run(args, ctx) {
      if (!(await supabaseAuthed(ctx))) return SUPABASE_LOGIN_HINT;
      return cli(ctx, `supabase ${String(args.subcommand)}`);
    },
  },
  {
    name: "supabase_status",
    description: "Check Supabase CLI login status and whether the workspace has a supabase/ project.",
    safety: "auto",
    parameters: { type: "object", properties: {} },
    async run(args, ctx) {
      const dir = ctx.cfg.agent.workspace || process.cwd();
      const who = await run(`supabase projects list`, { cwd: dir, timeoutMs: 60_000 });
      const linked = await run(`supabase status`, { cwd: dir, timeoutMs: 60_000 });
      return [
        who.code === 0 ? `Auth: OK (${who.stdout.split("\n")[0]?.trim() || "logged in"})` : `Auth: NOT LOGGED IN\n${SUPABASE_LOGIN_HINT}`,
        `Project status:\n${fmt(linked)}`,
      ].join("\n");
    },
  },
];
