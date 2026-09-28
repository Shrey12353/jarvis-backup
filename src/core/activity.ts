/**
 * Activity log — a plain-language record of what Jarvis actually did.
 *
 * One JSONL file per day under data/activity/ so the user can ask "what did you
 * do today?" (or open the Today panel) and see real actions, not logs. Every
 * entry is secret-redacted and truncated before it is written.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { redactSecrets } from "./cloud.js";

export interface ActivityEntry {
  at: string;
  tool: string;
  summary: string;
  ok: boolean;
}

export function activityDir(dataDir: string): string {
  return path.join(dataDir, "activity");
}

export function activityFile(dataDir: string, day?: string): string {
  const d = day ?? new Date().toISOString().slice(0, 10);
  return path.join(activityDir(dataDir), `${d}.jsonl`);
}

/** Tool name + arguments → one human sentence. Exported for tests. */
export function summarizeToolCall(name: string, args: Record<string, unknown> = {}): string {
  const a = (k: string): string => (args[k] === undefined ? "" : String(args[k]));
  const short = (s: string, n = 110): string => (s.length > n ? s.slice(0, n) + "…" : s);
  switch (name) {
    case "shell":
    case "shell_readonly":
      return `ran a command: ${short(a("command"))}`;
    case "read_file":
      return `read the file ${a("path")}`;
    case "write_file":
      return `created or updated the file ${a("path")}`;
    case "edit_file":
      return `edited the file ${a("path")}`;
    case "list_dir":
      return `looked through the folder ${a("path") || "(workspace)"}`;
    case "search_files":
      return `searched files for "${short(a("pattern"), 60)}"`;
    case "web_search":
      return `searched the web for "${short(a("query"), 80)}"`;
    case "browser_navigate":
      return `opened the page ${short(a("url"), 90)}`;
    case "browser_extract":
      return "read a web page";
    case "browser_screenshot":
      return "took a picture of a web page";
    case "browser_click":
    case "browser_type":
      return "used a website";
    case "open_url":
      return `opened ${short(a("url"), 90)} in your browser`;
    case "launch_app":
      return `launched ${a("name")}`;
    case "notify":
      return `showed you a notification: ${short(a("message"), 80)}`;
    case "read_clipboard":
      return "read your clipboard";
    case "screenshot_screen":
      return "looked at your screen";
    case "list_windows":
      return "checked which windows are open";
    case "describe_image":
      return `looked at the image ${a("path")}`;
    case "generate_image":
      return `created an image: ${short(a("prompt"), 90)}`;
    case "gmail_inbox":
      return "checked your email";
    case "gmail_read":
      return `read the email "${short(a("uid"), 60)}"`;
    case "gmail_send":
      return `sent an email to ${a("to")}`;
    case "gmail_reply":
      return `replied to an email about "${short(a("uid"), 60)}"`;
    case "gmail_setup_login":
      return "opened the Gmail sign-in window";
    case "trade_universe":
      return "checked the NSE stock universe";
    case "trade_signals":
      return "scanned NSE stocks for today's signals";
    case "trade_compare":
      return "compared all trading strategies";
    case "trade_backtest":
      return `backtested the ${a("strategy") || "default"} strategy`;
    case "trade_engine":
      return "ran the paper-trading engine";
    case "calendar_today":
      return "checked today's calendar";
    case "ollama_chat":
      return "asked the local model a quick question";
    case "ollama_pull":
      return `installed the AI model ${a("model")}`;
    case "remember":
      return `saved a fact about you: ${short(a("fact"), 90)}`;
    case "forget":
      return `forgot a fact: ${short(a("fact"), 90)}`;
    case "remind_add":
      return `set a reminder: ${short(a("text"), 80)} at ${a("when")}`;
    case "remind_cancel":
      return `cancelled a reminder: ${short(a("id_or_text"), 60)}`;
    case "remind_list":
      return "listed your reminders";
    case "what_did_you_do":
      return "checked what it has been doing";
    case "git_status":
      return "checked the git repository";
    case "git_commit":
      return `committed changes: ${short(a("message"), 80)}`;
    case "git_push":
      return "pushed code to GitHub";
    case "github":
      return `used GitHub (${short(a("args"), 60)})`;
    case "vercel_deploy":
      return "deployed to Vercel";
    case "supabase":
      return `used Supabase (${short(a("args"), 60)})`;
    case "vscode_open":
      return `opened ${a("path")} in VS Code`;
    default:
      return `used ${name}`;
  }
}

export async function logActivity(dataDir: string, tool: string, summary: string, ok: boolean): Promise<void> {
  try {
    const file = activityFile(dataDir);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const entry: ActivityEntry = {
      at: new Date().toISOString(),
      tool,
      summary: redactSecrets(String(summary ?? "")).replace(/\s+/g, " ").trim().slice(0, 240),
      ok,
    };
    await fsp.appendFile(file, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    /* the activity log must never break a task */
  }
}

export async function readActivity(dataDir: string, day?: string): Promise<ActivityEntry[]> {
  try {
    const raw = await fsp.readFile(activityFile(dataDir, day), "utf8");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as ActivityEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is ActivityEntry => !!e);
  } catch {
    return [];
  }
}

/** Keep the log folder small: drop day files older than `keepDays`. */
export async function pruneActivity(dataDir: string, keepDays = 30): Promise<void> {
  try {
    const dir = activityDir(dataDir);
    const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    for (const f of await fsp.readdir(dir)) {
      if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) < cutoff) {
        await fsp.rm(path.join(dir, f), { force: true });
      }
    }
  } catch {
    /* best-effort housekeeping */
  }
}
