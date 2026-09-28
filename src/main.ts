import readline from "node:readline";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadConfig, loadDotEnv, resolveWorkspaceCfg, type AppConfig } from "./core/config.js";
import { ensureDirs } from "./core/paths.js";
import { initLogging, log } from "./core/logger.js";
import { OllamaClient, isOllamaDownError, ollamaDownMessage, tryStartOllama, waitForOllama } from "./core/ollama.js";
import { Agent } from "./core/agent.js";
import { buildRegistry } from "./index.js";
import { shutdownBrowser } from "./tools/browser.js";
import { voiceLoop } from "./voice/loop.js";
import type { ToolRegistry } from "./tools/types.js";

interface CliArgs {
  mode: "chat" | "voice" | "run" | "doctor";
  prompt?: string;
  fullAuto?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const known = new Set(["chat", "voice", "run", "doctor"]);
  const args: CliArgs = { mode: "chat" };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--full-auto") args.fullAuto = true;
    else if (a === "-p" || a === "--prompt") args.prompt = argv[++i] ?? "";
    else rest.push(a);
  }
  if (rest.length && known.has(rest[0])) args.mode = rest.shift() as CliArgs["mode"];
  if (rest.length && !args.prompt) args.prompt = rest.join(" ");
  return args;
}

function makeRl(): readline.Interface {
  return readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
}

// If the user types a full sentence at a y/N prompt, queue it as the next chat message.
const pendingUserText: string[] = [];

async function confirmViaRl(rl: readline.Interface, action: string, description: string): Promise<boolean> {
  const answer = await new Promise<string>((res) =>
    rl.question(`\n⚠  APPROVAL NEEDED — ${action}\n   ${description}\n   \x1b[33mType ONLY y or n\x1b[0m [n]: `, res)
  );
  const t = answer.trim().toLowerCase();
  if (t === "y" || t === "yes") return true;
  if (t === "n" || t === "no" || t === "") return false;
  pendingUserText.push(answer.trim());
  console.log(`(treating that as "no" — and I'll use your message "${answer.trim().slice(0, 60)}..." as your next request)`);
  return false;
}

/**
 * Interactive logins (gh/vercel/supabase) need a real terminal — spawn one in a
 * NEW window so the user can complete them, then they can come back and chat.
 */
function openLoginWindow(command: string): void {
  if (process.platform === "win32") {
    // "start" opens a new console window that stays open (/k) after login finishes.
    spawn("cmd.exe", ["/c", "start", "Jarvis Login", "cmd", "/k", command], {
      detached: true,
      stdio: "ignore",
      shell: true,
    }).unref();
  } else {
    console.log(`(On this OS, open a separate terminal and run: ${command})`);
  }
}

const LOGIN_HINTS: Record<string, string> = {
  "/gh": "gh auth login",
  "/vercel": "vercel login",
  "/supabase": "supabase login",
};

/** Make sure the AI brain is reachable before starting; try to start it if not. Never throws for "down". */
async function ensureBrain(ollama: OllamaClient, host: string): Promise<boolean> {
  try {
    await ollama.listModels();
    return true;
  } catch (e) {
    if (!isOllamaDownError(e)) throw e;
    console.log("Ollama isn't responding — trying to start it for you...");
    tryStartOllama();
    const ok = await waitForOllama(ollama, 45_000, 2_000);
    if (!ok) console.log("\n" + ollamaDownMessage(host) + "\n");
    return ok;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  await loadDotEnv();
  const cfg = await loadConfig();
  cfg.agent.workspace = resolveWorkspaceCfg(cfg);
  if (args.fullAuto) {
    cfg.agent.full_auto = true;
    console.log("⚠  FULL-AUTO enabled — \"ask\" tier tools will run without confirmation.");
  }
  await ensureDirs(cfg.paths.data);
  initLogging(cfg.paths.data);

  if (args.mode === "doctor") {
    await doctor(cfg);
    return;
  }

  const registry = buildRegistry();
  const ollama = new OllamaClient(cfg.ollama.host);
  const brainOk = await ensureBrain(ollama, cfg.ollama.host);
  if (!brainOk && (args.mode === "chat" || args.mode === "voice")) {
    console.log("\n(I'll still open — but I can't think until Ollama is running. Quit, start Ollama, reopen.)\n");
  }
  const sessionFile = path.join(cfg.paths.data, "sessions", "session.json");
  const agent = new Agent(cfg, registry, sessionFile, { dataDir: cfg.paths.data });
  await agent.loadSession();
  console.log(`Workspace: ${cfg.agent.workspace}`);

  if (args.mode === "run") {
    if (!args.prompt) {
      console.log('Usage: npm run run -- "your request here"  (or: agent run "..." )');
      process.exitCode = 1;
      return;
    }
    const rl = makeRl();
    if (!brainOk) {
      process.exitCode = 1;
      rl.close();
      await shutdownBrowser();
      return;
    }
    let streamed = "";
    const result = await agent.run(args.prompt, {
      confirm: (action, description) => {
        if (cfg.agent.full_auto && !description.startsWith("[DANGEROUS]")) return Promise.resolve(true);
        return confirmViaRl(rl, action, description);
      },
      onToolCall: (name, a) => console.log(`🔧 ${name} ${Object.entries(a).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ")}`),
      onToolResult: (name, res, ok) => console.log(`   ↳ ${name}: ${ok ? "ok" : "FAILED"} — ${res.split("\n")[0].slice(0, 160)}`),
      onContent: (d) => {
        streamed += d;
        process.stdout.write(d);
      },
    });
    process.stdout.write("\n\n");
    if (!streamed.trim()) console.log(result.answer || "(no answer)");
    rl.close();
    await shutdownBrowser();
    return;
  }

  if (args.mode === "voice") {
    await voiceLoop(cfg, agent);
    await shutdownBrowser();
    return;
  }

  // ---- Interactive chat mode ----
  console.log(`Jarvis ready — model: ${cfg.ollama.model} @ ${cfg.ollama.host}`);
  console.log("Commands: /tools  /new  /auto  /quit");
  const rl = makeRl();
  const confirm = async (action: string, description: string): Promise<boolean> => {
    // In full-auto, approve normal asks; still confirm anything marked DANGEROUS
    if (cfg.agent.full_auto && !description.startsWith("[DANGEROUS]")) return true;
    return confirmViaRl(rl, action, description);
  };

  try {
    for (;;) {
      let line: string;
      try {
        line = (await new Promise<string>((res) => rl.question("\nyou › ", res))).trim();
      } catch {
        // stdin closed (Ctrl+C, closed console, or piped input ending) — exit politely.
        break;
      }
      if (!line && pendingUserText.length) line = pendingUserText.shift()!;
      if (!line) continue;
      if (line === "/quit" || line === "/exit") break;
      if (line === "/tools") {
        for (const t of registry.list()) console.log(`  ${t.safety.padEnd(10)} ${t.name} — ${t.description}`);
        continue;
      }
      if (line === "/new") {
        await agent.reset();
        console.log("(session cleared)");
        continue;
      }
      if (line === "/auto") {
        cfg.agent.full_auto = !cfg.agent.full_auto;
        console.log(`full_auto = ${cfg.agent.full_auto}`);
        continue;
      }
      if (LOGIN_HINTS[line]) {
        console.log(`Opening a login window for: ${LOGIN_HINTS[line]}\nComplete it there, then come back here.`);
        openLoginWindow(LOGIN_HINTS[line]);
        continue;
      }
      if (/^\s*(gh|vercel|supabase)\s+auth\s+login|^(gh|vercel|supabase)\s+login\s*$/.test(line)) {
        const cmd = line.trim();
        console.log(`Logins need a real terminal window — opening one for: ${cmd}\nComplete it there, then come back here.`);
        openLoginWindow(cmd);
        continue;
      }
      const result = await agent.run(line, {
        confirm,
        onToolCall: (name, a) => console.log(`🔧 ${name} ${Object.entries(a).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ")}`),
        onToolResult: (name, res, ok) => console.log(`   ↳ ${name}: ${ok ? "ok" : "FAILED"} — ${res.split("\n")[0].slice(0, 160)}`),
        onContent: (d) => process.stdout.write(d),
      });
      process.stdout.write("\n");
      if (!result.answer) console.log("(no answer — step limit hit, ask me to continue)");
    }
  } finally {
    rl.close();
    await shutdownBrowser();
  }
}

async function doctor(cfg: AppConfig): Promise<void> {
  console.log("== jarvis doctor ==\n");
  console.log(`workspace:  ${cfg.agent.workspace}`);
  console.log(`full_auto:  ${cfg.agent.full_auto}`);
  console.log(`data dir:   ${cfg.paths.data}`);

  const ollama = new OllamaClient(cfg.ollama.host);
  try {
    const models = await ollama.listModels();
    console.log(`ollama:     OK — ${models.length} model(s)`);
    const has = await ollama.hasModel(cfg.ollama.model);
    console.log(`  model '${cfg.ollama.model}': ${has ? "present" : "MISSING — run: ollama pull " + cfg.ollama.model}`);
  } catch (e) {
    console.log(`ollama:     FAIL — ${e instanceof Error ? e.message : e}`);
    console.log("  → install from https://ollama.com then: ollama pull " + cfg.ollama.model);
  }

  const { run } = await import("./core/proc.js");
  const checks: Array<[string, string, string]> = [
    ["git", "git --version", "https://git-scm.com"],
    ["gh (GitHub CLI)", "gh --version", "winget install GitHub.cli"],
    ["vercel", "vercel --version", "npm i -g vercel"],
    ["supabase", "supabase --version", "npm i -g supabase"],
    ["node", "node --version", "https://nodejs.org"],
  ];
  for (const [name, cmd, hint] of checks) {
    const r = await run(cmd, { timeoutMs: 20_000 });
    const v = r.code === 0 ? (r.stdout.split("\n")[0] || "OK").trim() : "MISSING";
    console.log(`${name.padEnd(16)} ${v}${r.code !== 0 ? `  → ${hint}` : ""}`);
  }

  try {
    await import("playwright");
    console.log(`playwright:      installed — run 'npm run setup:browser' once for the browser tools`);
  } catch {
    console.log(`playwright:      MISSING  → npm install && npm run setup:browser`);
  }

  for (const k of ["GITHUB_TOKEN", "VERCEL_TOKEN", "SUPABASE_ACCESS_TOKEN"]) {
    console.log(`${k.padEnd(18)} ${process.env[k] ? "set" : "(optional, unset)"}`);
  }
  console.log("\nVoice: wake word needs Porcupine + PICOVOICE_ACCESS_KEY; STT needs whisper.cpp or a vosk model; see README.");
}

main().catch((e) => {
  console.error("fatal:", e);
  void log(`fatal: ${e instanceof Error ? e.stack : String(e)}`, "error").finally(() => process.exit(1));
});
