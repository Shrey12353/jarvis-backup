import { promises as fs } from "node:fs";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { OllamaClient, isOllamaDownError, ollamaDownMessage, waitForOllama, type ChatResponse, type OllamaMessage, type OllamaTool } from "./ollama.js";
import { CloudClient, cloudConfigured, slimForCloud } from "./cloud.js";
import { loadMemoryText, memoryPromptSection } from "./memory.js";
import { resolveReadRoots } from "./config.js";
import type { ToolContext, ToolRegistry } from "../tools/types.js";
import { nowStamp, truncate } from "./util.js";

export interface Session {
  file: string;
  messages: OllamaMessage[];
}

/**
 * True when a tool result means the call itself failed (bad arguments, missing
 * folder, spawn failure) — as opposed to a command that merely exited non-zero.
 * Used to stop the model from repeating identical failing calls forever.
 */
export function isRepeatedFailure(ok: boolean, result: string): boolean {
  if (!ok) return true;
  // Any non-zero exit (or timeout) is a failure for repeat-guard purposes —
  // shell tools bury the exit code at the end of their output text.
  const m = /\[exit (-?\d+)( TIMED OUT)?\]/.exec(result);
  if (m && Number(m[1]) !== 0) return true;
  return /^(Error|Refused|Tool error):/m.test(result);
}

const RETRY_NUDGE =
  "\n\n[System: this exact call has now failed twice with the same error. Repeating it a third time is blocked. Change something meaningful — use a tool that fits the task, create the missing file/folder first, or fix the arguments — or stop and tell the user what is blocking you.]";

const RETRY_BLOCKED =
  "Blocked: this exact tool call has already failed multiple times with the same error and will not run again. Do NOT retry it. Try a different approach (different tool or different arguments) or stop and tell the user what is blocked.";

const MAX_IDENTICAL_FAILURES = 2;

export class Agent {
  private client: OllamaClient;
  private cfg: AppConfig;
  private registry: ToolRegistry;
  private session: Session;
  /** Signature of a tool call -> how many times it failed in a row. */
  private failedCalls = new Map<string, number>();
  /** How long to wait for the brain to come back when it drops mid-chat. */
  private ollamaGraceMs: number;
  /** Optional cloud brain (Groq/OpenRouter-style). null = local-only. */
  private cloud: CloudClient | null;
  /** Second free provider — absorbs quota dips so the local brain rarely runs. */
  private cloudBackup: CloudClient | null;
  /** After a cloud error, skip the cloud until this timestamp (local fallback). */
  private cloudDeadUntil = 0;
  private backupDeadUntil = 0;
  /** Where long-term memory lives (data/memory/user.md). Empty = no memory. */
  private dataDir: string;
  /** Static half of the system prompt — built once, reused for every chat. */
  private basePromptCache: string | null = null;
  /** Memory text already baked into the system message (detects changes). */
  private memoryStamp = "";

  constructor(
    cfg: AppConfig,
    registry: ToolRegistry,
    sessionFile: string,
    opts: { ollamaGraceMs?: number; dataDir?: string } = {}
  ) {
    this.cfg = cfg;
    this.registry = registry;
    this.dataDir = opts.dataDir ?? "";
    this.ollamaGraceMs = opts.ollamaGraceMs ?? 20_000;
    this.client = new OllamaClient(cfg.ollama.host);
    this.cloud = cloudConfigured(cfg) ? new CloudClient(cfg.cloud!) : null;
    this.cloudBackup = cloudConfigured(cfg, true) ? new CloudClient(cfg.cloud_backup!) : null;
    this.session = { file: sessionFile, messages: [] };
  }

  /**
   * Clean up dangling user messages left by previous crashes (saved but never
   * answered): a new user message supersedes an unanswered earlier one, and
   * trailing unanswered user messages are dropped so history stays coherent.
   */
  static tidyMessages(messages: OllamaMessage[]): OllamaMessage[] {
    const out: OllamaMessage[] = [];
    for (const m of messages) {
      if (m.role === "user") {
        while (out.length && out[out.length - 1].role === "user") out.pop();
        out.push(m);
      } else {
        out.push(m);
      }
    }
    while (out.length && out[out.length - 1].role === "user") out.pop();
    return out;
  }

  async loadSession(): Promise<void> {
    try {
      const raw = await fs.readFile(this.session.file, "utf8");
      const parsed = JSON.parse(raw) as { messages?: OllamaMessage[] };
      this.session.messages = parsed.messages ?? [];
    } catch {
      this.session.messages = [];
    }
    this.session.messages = Agent.tidyMessages(this.session.messages);
    if (!this.session.messages.length) {
      this.session.messages.push({ role: "system", content: await this.systemPrompt() });
    }
  }

  async reset(): Promise<void> {
    this.session.messages = [{ role: "system", content: await this.systemPrompt() }];
    await this.persist();
  }

  /**
   * The system prompt = static rules (built once) + the user's long-term
   * memory. Keeping the static half cached means "systeminfo" isn't re-run for
   * every chat, while memory stays fresh.
   */
  private async systemPrompt(): Promise<string> {
    if (!this.basePromptCache) this.basePromptCache = await this.buildSystemPrompt();
    const memory = this.dataDir ? await loadMemoryText(this.dataDir) : "";
    this.memoryStamp = memory;
    return this.basePromptCache + memoryPromptSection(memory);
  }

  /** Re-read memory mid-chat so a fact saved this turn is visible next turn. */
  private async refreshMemory(): Promise<void> {
    if (!this.dataDir || !this.basePromptCache) return;
    const memory = await loadMemoryText(this.dataDir);
    if (memory === this.memoryStamp) return;
    this.memoryStamp = memory;
    const content = this.basePromptCache + memoryPromptSection(memory);
    const sys = this.session.messages.find((m) => m.role === "system");
    if (sys) sys.content = content;
    else this.session.messages.unshift({ role: "system", content });
  }

  private async buildSystemPrompt(): Promise<string> {
    const ws = this.cfg.agent.workspace || "(workspace)";
    const platform = process.platform;
    let profile = "";
    if (platform === "win32") {
      const w = await import("./proc.js");
      const r = await w.run("systeminfo | findstr /B /C:\"OS Name\" /C:\"OS Version\" & node --version & git --version", { timeoutMs: 30_000 });
      profile = r.stdout.trim().slice(0, 500);
    } else {
      profile = `${process.platform} ${process.arch}, node ${process.version}`;
    }
    const tools = this.registry.describe();
    return [
      `You are Jarvis, a personal AI agent running on the user's PC. You operate the computer on their behalf via tools.`,
      ``,
      `## Environment`,
      `- Platform: ${platform}`,
      `- Working directory: ${ws}`,
      `- Machine profile: ${profile || "unknown"}`,
      `- Date: ${new Date().toISOString()}`,
      `- Folders I may READ (never write): ${resolveReadRoots(this.cfg).join(", ") || "(none)"}`,
      ``,
      `## How to work`,
      `- ACT, DON'T TEACH. The user never writes code and never follows tutorials. When asked to create/build/make something, DO IT yourself with tools (write_file, edit_file, shell) and report the finished result. NEVER reply with setup instructions, "here are the steps", or code for the user to run — that is a failure. If a sub-agent or helper program is requested, you write its code into the workspace, run it to prove it works, and then report in plain language.`,
      `- OUTPUT STYLE: give ONLY the finished result — the answer, the summary, the file, the picture. Do NOT narrate your process ("let me check", "I will now read the file", "next I will..."). If information you need is already in the conversation (e.g. attached-file content shown above), USE it and answer directly — NEVER ask the user for file paths or to re-send attachments. Ask the user a question ONLY when something essential is genuinely missing (e.g. "which language should the reply be in?").`,
      `- PARAMETERS ARE LAW: if the user gives specifics — counts ("10 ideas"), names, file names, quantities, prices, dates — follow them EXACTLY. Never substitute, reduce, or add your own numbers; if your plan or a tool result conflicts with what the user asked for, the USER wins. Before sending any answer, re-check it against every number and name they gave.`,
      `- ONE COMPLETE REPLY: answer fully in a single response. NEVER split a finished answer across turns ("part 2 coming"), NEVER end with "want me to continue?" / "shall I...?" — if a step remains, DO it silently with tools and then give the complete result.`,
      `- ATTACHED FILES: their content is usually already included in the user's message — answer from it directly WITHOUT calling read_file. Only open an attached file with a tool if the user asks for detail beyond what is shown. When you do open one, use the exact path given in the [Attached ...] note (e.g. "data/uploads/...") — it is relative to the workspace.`,
      `- All file tools are confined to the working directory shown above. Absolute paths outside it and "../" escapes are refused — always use paths relative to it.`,
      `- The shell's cwd must be a folder that already exists inside the working directory. If you get "folder does not exist", create it with write_file first, or run list_dir to see what is actually there.`,
      `- If a tool call fails twice with the same error, never repeat it a third time unchanged. Change approach or tell the user exactly what is blocked.`,
      `- Prefer one small tool call at a time; read results before deciding the next step.`,
      `- Building a sub-agent/helper AI: create a small Node script in the workspace that calls the ollama_chat tool (model calls) plus its own prompt file defining its personality/job. Give it a distinct name and system prompt. Test it by running it with the shell tool. It reports to you; you relay results to the user.`,
      `- The user may attach files (images, PDFs, documents) in the web UI. Attached images are shown to a vision model and described in the user message; PDFs and text files are extracted to readable text files in the workspace — use read_file on the paths given in the message to see their contents.`,
      `- If the user attaches an image but no vision model is configured, offer to install one yourself with the ollama_pull tool (e.g. llava:7b or moondream — tell them the download size first).`,
      `- EMAIL SETUP: when the user asks to set up / connect their email (or any gmail tool reports a sign-in is needed), CALL gmail_setup_login immediately as your action — never reply with instructions, and never say a window is open unless the tool result says so.`,
      `- EMAIL: You can read the user's Gmail (gmail_inbox, gmail_read — read-only) and send/reply (gmail_send, gmail_reply). RULES: never send or reply without showing the user the exact text first and getting their OK (the tools raise an approval card — always let it happen). Never invent recipients or addresses. If a gmail tool says a sign-in is needed, tell the user a browser window is open for a ONE-TIME sign-in with their normal Google account — no app passwords, no technical steps. A daily unread-mail summary is added to the morning report automatically.`,
      `- STAY IN YOUR LANE online: browse only what the user's request needs. NEVER open banking, crypto-trading, adult or gambling sites; NEVER enter payment/card details, passwords, OTPs or identity numbers anywhere; NEVER log into any account other than the user's own connected ones (Gmail after their one-time sign-in). If a page demands any of these, stop and tell the user plainly why.`,
      `- DESTRUCTIVE = ASK FIRST: even when a tool would run without asking, anything irreversible — deleting a repo/database/project, closing or deleting issues or PRs, dropping tables, removing deployments, force-pushing history — needs the user's explicit OK with the exact target named in chat before you act. Create/update/enable freely; destroy only on confirmed instruction.`,
      `- PRIVACY: the user's files, emails, memories and screen contents are theirs. Never paste their personal content into unrelated websites, forms or tools, and never send their data anywhere except to complete the exact request they made.`,
      `- IMAGES ON REQUEST: when the user asks you to create/draw/generate a picture, logo, poster or illustration, call generate_image IMMEDIATELY as your FIRST action — invent the vivid description yourself from whatever they asked for (e.g. "superhero cat cartoon" -> prompt: "a superhero cat wearing a cape and mask, cartoon style, vibrant colors"). NEVER ask them clarifying questions first, NEVER explain how image creation works, NEVER reply with text only. The tool returns an IMAGES: block; copy it into your reply EXACTLY. For several pictures, call the tool once per picture.`,
      `- REMEMBERING: when the user tells you something worth keeping (their name, work, study, city, goals, important dates, preferences, how they like things done) call remember with ONE short fact. Never ask permission — save it and carry on. Use forget when they ask you to drop something. Your long-term memory is shown at the end of this prompt; NEVER claim you cannot remember across chats — you do.`,
      `- REMINDERS: when the user wants to be reminded or pinged later ("remind me at 6pm", "every weekday at 9") call remind_add with an exact date-time computed from the current date above, then confirm in one short line. remind_list shows them, remind_cancel removes one. Repeats: none | daily | weekdays | weekly.`,
      `- For coding tasks: create/edit files with the filesystem tools, run builds/tests with shell, then commit with git tools when asked.`,
      `- For GitHub/Vercel/Supabase tasks: check auth with the tool's status command first; if not logged in, tell the user exactly which command to run interactively (gh auth login, vercel login, supabase login) — do not ask for passwords.`,
      `- SEEING THE PC: when the user asks about something on their screen, or about text they copied, use screenshot_screen (and include the picture in your reply as ![screen](path)) and read_clipboard — do NOT ask them to explain or re-type it. list_windows answers "what is open?". describe_image reads any image file (attachments included) when you need to look at it again.`,
      `- The user's OWN files live outside the workspace. You may READ them (see the folders line above) but never write outside the workspace — to change such a file, copy it into the workspace first. This is not an error: just read it and answer.`,
      `- ACTIVITY: what_did_you_do lists what you actually did today from the activity log — use it for "what have you been up to?" or "what did you do today?".`,
      `- When you finish a multi-step task, summarize what you did and any next steps.`,
      `- Never claim an action succeeded without a tool result confirming it.`,
      `- NEVER fabricate or improvise a person's or tool's output. If a tool fails or returns an error, say so plainly and try again or report the failure — do not invent what it "would have said" and never pass off other results as its.`,
      `- Keep answers concise; you are often spoken aloud via TTS.`,
      ``,
      `## Trading system (Indian markets)`,
      `- You have native trading tools: trade_universe, trade_signals, trade_compare, trade_backtest, trade_engine. They call the trading engine directly — do NOT use shell to run npm trade commands.`,
      `- The user is NOT a coder and speaks plain language. When they ask about stocks, trading, "what to buy today", "how did the strategy do" — use these tools and explain results simply (no jargon without explanation).`,
      `- Five strategies run side by side: trend-cross, rsi-reversion (default), breakout, momentum, volume-surge. Use trade_compare to answer "which strategy is best" and trade_signals to see what each flags today.`,
      `- Capital: Rs10,000. The Survive/Die governor caps positions (max 4 x Rs2,000, 5% stop-loss, lock at Rs7,000 equity). Never suggest bypassing risk limits.`,
      `- ALL trading is PAPER (simulated) until a real broker API (Angel One SmartAPI / Zerodha Kite Connect) is connected. Never tell the user a real order was placed. If they ask to trade real money, explain exactly what setup remains.`,
      `- These scans take 3-8 minutes on this CPU — warn the user to wait, then report results in plain language.`,
      ``,
      `## Available tools`,
      tools.map((t) => `- ${t.name}: ${t.description}`).join("\n"),
    ].join("\n");
  }

  /** One user request → multi-step tool loop → final answer text. */
  async run(
    userText: string,
    hooks: {
      onContent?: (delta: string) => void;
      onToolCall?: (name: string, args: Record<string, unknown>) => void;
      onToolResult?: (name: string, result: string, ok: boolean) => void;
      confirm?: (action: string, description: string) => Promise<boolean>;
      signal?: AbortSignal;
      /** Live progress from a long-running tool (goes straight to the UI). */
      onToolProgress?: (name: string, message: string) => void;
      /** true = stream only the final answer; interim narration is suppressed. */
      finalOnly?: boolean;
    } = {}
  ): Promise<{ answer: string; steps: number }> {
    let currentTool = "";
    const ctx: ToolContext = {
      cfg: this.cfg,
      confirm: hooks.confirm ?? (async () => true),
      signal: hooks.signal,
      progress: (message: string) => {
        try {
          hooks.onToolProgress?.(currentTool, message);
        } catch {
          /* progress must never break a run */
        }
      },
    };
    // While tools are still being chosen, interim model output is narration
    // ("Let me check..."). The pass that runs AFTER the last tool result
    // produces the real answer. In finalOnly mode we hold its text back and
    // release it only once we KNOW the pass produced no further tool calls —
    // so the user only ever sees the finished answer, never narration, and
    // the answer ALWAYS arrives even if the model also asked for tools.
    let toolPhase = false;
    let answerPhase = false;
    let pending = ""; // buffered deltas of the pass that should be the answer
    const contentHook = (d: string) => {
      if (!hooks.finalOnly) { hooks.onContent?.(d); return; }
      if (answerPhase) pending += d;
    };

    this.failedCalls.clear(); // fresh request: past failures shouldn't block fresh attempts
    await this.refreshMemory(); // a fact remembered last turn is visible immediately
    this.session.messages.push({ role: "user", content: userText });
    await this.persist();

    let steps = 0;
    let answer = "";

    // Free cloud tiers cap INPUT TOKENS PER MINUTE (Groq: ~7k for Jarvis's
    // models). Budget each minute locally: estimate the payload before sending
    // and use the local brain for the rest of the minute when it wouldn't fit —
    // no wasted round-trips, and the cloud returns at the next minute.
    let budgetMin = -1;
    let budgetLeft = 0;
    const estimateTokens = (msgs: OllamaMessage[]): number => {
      // Estimate the SLIMMED payload (that's what actually goes to the cloud).
      const slim = slimForCloud(msgs);
      const chars = slim.reduce((a, m) => a + m.content.length, 0) + 4_500; // + slimmed tools + JSON
      return Math.min(Math.ceil(chars / 3.2), 7_000);
    };

    while (steps < this.cfg.agent.max_steps) {
      steps++;
      // Stop button: bail out cleanly between model passes.
      if (hooks.signal?.aborted) { answer = "Stopped."; break; }
      answerPhase = toolPhase; // after tools have run, the next pass should be the answer
      const tools = this.registry.schemas();
      const thinkLocal = (): Promise<ChatResponse> =>
        this.client.chat(this.cfg.ollama.model, this.session.messages, tools, {
          temperature: this.cfg.ollama.temperature,
          num_ctx: this.cfg.ollama.num_ctx,
          onContent: contentHook,
          signal: hooks.signal,
        });
      let res: ChatResponse | undefined;
      try {
        const nowMin = Math.floor(Date.now() / 60_000);
        if (budgetMin !== nowMin) {
          budgetMin = nowMin;
          budgetLeft = 5_000; // headroom under Groq's ~8k-token-per-minute free cap
        }
        const est = estimateTokens(this.session.messages);
        const useCloud = !!this.cloud && Date.now() >= this.cloudDeadUntil && budgetLeft >= est;
        const useBackup = !useCloud && !!this.cloudBackup && Date.now() >= this.backupDeadUntil;
        if (useCloud || useBackup) {
          if (useCloud) budgetLeft -= est;
          const brain = useCloud ? this.cloud! : this.cloudBackup!;
          const brainName = useCloud ? "cloud" : "cloud-backup";
          try {
            res = await brain.chat(this.session.messages, tools, {
              temperature: this.cfg.ollama.temperature,
              onContent: contentHook,
              signal: hooks.signal,
            });
          } catch (e0) {
            if (hooks.signal?.aborted) throw e0;
            // "Request too large" (free tiers cap tokens per request) is not a
            // rate limit: retry the SAME brain with a trimmed history instead of
            // dropping to the slow local model. Fresh chat + one long message is
            // the usual trigger; the short retry almost always fits.
            const m0 = e0 instanceof Error ? e0.message : String(e0);
            let e: unknown = e0;
            let recovered = false;
            if (/too large|context length|maximum context|per minute|TPM/i.test(m0)) {
              const tail = this.session.messages.filter((m) => m.role !== "system").slice(-8);
              const sys = this.session.messages.filter((m) => m.role === "system");
              try {
                res = await brain.chat([...sys, ...tail], tools, {
                  temperature: this.cfg.ollama.temperature,
                  onContent: contentHook,
                  signal: hooks.signal,
                });
                recovered = true;
              } catch (e2) {
                e = e2;
              }
            }
            if (!recovered) {
              // Rate-limited → that provider sits out ~1 minute. If the primary
              // failed, try the backup before giving up; last resort = local.
              const msg = e instanceof Error ? e.message : String(e);
              if (useCloud) this.cloudDeadUntil = Date.now() + (/429|rate limit/i.test(msg) ? 65_000 : 60_000);
              else this.backupDeadUntil = Date.now() + (/429|rate limit/i.test(msg) ? 65_000 : 60_000);
              if (useCloud && this.cloudBackup) {
                console.warn(`[jarvis] ${brainName} unavailable (${msg.slice(0, 120)}); trying backup cloud.`);
                try {
                  res = await this.cloudBackup.chat(this.session.messages, tools, {
                    temperature: this.cfg.ollama.temperature,
                    onContent: contentHook,
                    signal: hooks.signal,
                  });
                } catch (e2) {
                  if (hooks.signal?.aborted) throw e2;
                  this.backupDeadUntil = Date.now() + 65_000;
                  console.warn(`[jarvis] backup cloud also unavailable; using local Ollama.`);
                  res = await thinkLocal();
                }
              } else {
                console.warn(`[jarvis] ${brainName} unavailable (${msg.slice(0, 140)}); using local Ollama.`);
                res = await thinkLocal();
              }
            }
          }
        } else {
          res = await thinkLocal();
        }
      } catch (e) {
        // Stop button pressed while the brain was thinking → clean stop.
        if (hooks.signal?.aborted) { answer = "Stopped."; break; }
        const down = isOllamaDownError(e);
        if (down) {
          // The brain is unreachable — give it a short grace period (it may be
          // booting after PC start), then fail with a plain-language answer.
          const back = await waitForOllama(this.client, this.ollamaGraceMs, 250);
          if (back) {
            try {
              res = await this.client.chat(
                this.cfg.ollama.model,
                this.session.messages,
                tools,
                {
                  temperature: this.cfg.ollama.temperature,
                  num_ctx: this.cfg.ollama.num_ctx,
                  onContent: contentHook,
                  signal: hooks.signal,
                }
              );
            } catch (e2) {
              answer = isOllamaDownError(e2) ? ollamaDownMessage(this.cfg.ollama.host) : this.failAnswer(e2);
              break;
            }
          } else {
            answer = ollamaDownMessage(this.cfg.ollama.host);
            break;
          }
        } else {
          answer = this.failAnswer(e);
          break;
        }
      }

      if (!res) {
        answer = "Something went wrong while I was thinking — please ask me again.";
        break;
      }

      if (res.toolCalls.length) {
        toolPhase = true;
        pending = ""; // this pass was narration, not the answer — drop it
        this.session.messages.push({
          role: "assistant",
          content: res.content,
          tool_calls: res.toolCalls.map((tc) => ({
            function: { name: tc.name, arguments: tc.args },
          })),
        });
        for (const tc of res.toolCalls) {
          if (hooks.signal?.aborted) break; // stop button — run no further tools
          const sig = `${tc.name} ${JSON.stringify(tc.args)}`;
          const fails = this.failedCalls.get(sig) ?? 0;
          currentTool = tc.name;
          hooks.onToolCall?.(tc.name, tc.args);
          let result: string;
          let ok: boolean;
          if (fails >= MAX_IDENTICAL_FAILURES) {
            result = RETRY_BLOCKED;
            ok = false;
          } else {
            const ex = await this.registry.execute(tc.name, tc.args, ctx);
            result = ex.result;
            ok = ex.ok;
            if (isRepeatedFailure(ex.ok, ex.result)) {
              this.failedCalls.set(sig, fails + 1);
              if (fails + 1 >= MAX_IDENTICAL_FAILURES) result += RETRY_NUDGE;
            } else {
              this.failedCalls.delete(sig);
            }
          }
          hooks.onToolResult?.(tc.name, result, ok);
          this.session.messages.push({
            role: "tool",
            content: truncate(result, 8_000),
          });
        }
        await this.persist();
        if (hooks.signal?.aborted) { answer = "Stopped."; break; }
        continue;
      }

      // No tool calls — this pass IS the answer. Release the held-back text.
      if (hooks.finalOnly && pending) hooks.onContent?.(pending);
      pending = "";
      answer = res.content;
      break;
    }

    if (steps >= this.cfg.agent.max_steps && !answer) {
      answer = "I hit my step limit before finishing. Here is where I got — ask me to continue.";
    }
    if (answer) {
      this.session.messages.push({ role: "assistant", content: answer });
      await this.persist();
    }
    return { answer, steps };
  }

  async history(): Promise<OllamaMessage[]> {
    return this.session.messages;
  }

  /** A safe, plain-language answer for unexpected model errors (never crash). */
  private failAnswer(e: unknown): string {
    const msg = e instanceof Error ? e.message : String(e);
    return [
      `Something went wrong while I was thinking — but I'm still here.`,
      ``,
      `Technical detail: ${truncate(msg, 300)}`,
      ``,
      `What usually helps: try your request again; if it repeats, restart me (close the window, double-click the launcher).`,
    ].join("\n");
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.session.file), { recursive: true });
    await fs.writeFile(this.session.file, JSON.stringify({
      savedAt: nowStamp(),
      messages: this.session.messages,
    }, null, 2), "utf8");
  }
}
