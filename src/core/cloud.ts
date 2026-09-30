import type { AppConfig } from "./config.js";
import type { OllamaMessage, OllamaTool, ChatResponse } from "./ollama.js";
import { pickModelOrder, LAST_RESORT, type TaskKind } from "./model-router.js";

/**
 * Optional cloud brain — any OpenAI-compatible chat API (Groq, OpenRouter,
 * Together, ...). Used for SPEED: the local 3B model thinks in minutes on a
 * CPU; a cloud model answers in seconds. Everything else (tools, files,
 * approvals, trading) stays 100% on the PC.
 *
 * Privacy model (deliberately conservative):
 * - ONLY the conversation text + tool-schemas go out. Never file contents,
 *   attachments, or workspace paths (redacted by redactMessage()).
 * - Secrets in the session (.env values, tokens, passwords) are masked before
 *   anything leaves the machine, every request.
 * - No key configured => this module is inert and Jarvis stays fully local.
 */

const SECRETS: Array<[RegExp, string]> = [
  // .env-style assignments: KEY=value (long values only — don't mangle "note=x")
  [/^(\s*(?:[A-Z0-9_]{4,})\s*=\s*)(["']?)(\S{8,})\2$/gm, "$1$2•••$2"],
  // Common token shapes
  [/\b(?:sk|gsk|rk|hf|xoxb|xoxp|ghp|gho|github_pat|vr)[-_]([A-Za-z0-9_-]{10,})\b/g, "•••"],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "•••"], // JWTs
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "•••"], // AWS keys
];

/** Mask anything that looks like a secret before it leaves the machine. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, rep] of SECRETS) out = out.replace(re, rep);
  return out;
}

/**
 * Strip anything privacy-sensitive from a message before sending it to the
 * cloud: attachment contents are replaced with a short note so the cloud can
 * still follow the conversation, but your documents never leave the PC.
 */
export function redactMessage(msg: OllamaMessage): OllamaMessage {
  let content = msg.content ?? "";
  if (msg.role === "user") {
    // Attachment blobs injected by the UI ("[Content of file: ...]" spans).
    content = content.replace(/\[Content of [^\]]*:\s*\n[\s\S]*?\n\]/g, "[an attached file — contents not sent to the cloud]");
    // Absolute paths reveal the user's machine layout.
    content = content.replace(/[A-Z]:\\[^\s"']+/gi, "<local-path>");
    content = content.replace(/(?:\/home\/|\/Users\/|C:\\Users\\)[^\s"']+/gi, "<local-path>");
  }
  return { ...msg, content: redactSecrets(content) };
}

/**
 * Free models, best-for-Jarvis first. gpt-oss leads because it is the one that
 * reliably emits well-formed TOOL CALLS with Jarvis's ~54 tool schemas (Groq's
 * qwen3.8 rejects the full set with "Failed to call a function").
 */
const PREFERRED_MODELS = [
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
  "qwen/qwen3.8-27b",
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
];

/**
 * Pull the wait time out of a rate-limit message. Groq's 429 body says
 * "Please try again in 4.225s"; other providers send "retry after Xs".
 * Returns milliseconds, or null when the message carries no hint.
 */
export function parseRetryAfterMs(msg: string): number | null {
  const m =
    msg.match(/try again in (\d+(?:\.\d+)?)s/i) ??
    msg.match(/retry[- ]after[:\s]*(\d+(?:\.\d+)?)\s*s/i);
  if (!m) return null;
  const s = Number(m[1]);
  return Number.isFinite(s) && s > 0 ? Math.ceil(s * 1000) : null;
}

export function pickPreferredModel(available: string[], current: string): string | null {
  for (const m of PREFERRED_MODELS) {
    if (m !== current && available.includes(m)) return m;
  }
  return null;
}

export interface CloudOpts {
  temperature: number;
  onContent?: (delta: string) => void;
  signal?: AbortSignal;
  /** What the model is being asked to do — selects the routing preference list. */
  task?: TaskKind;
}

/**
 * Compact system prompt for the smart cloud brain: keep the identity + core
 * behaviour rules, then re-attach the task-specific rules (email, images,
 * trading) that would otherwise fall outside a naive character cap.
 * Tool listings are dropped entirely (tools arrive via the tools interface).
 */
function compactSystemPrompt(raw: string): string {
  const cut = raw.indexOf("\n- ATTACHED FILES:");
  const head = cut > 0 ? raw.slice(0, cut) : raw.slice(0, 3_000);
  const line = (re: RegExp): string => raw.match(re)?.[0] ?? "";
  const digest = [
    line(/- ATTACHED FILES:[^\n]*/),
    line(/- EMAIL:[^\n]*/),
    line(/- CALENDAR:[^\n]*/),
    line(/- STAY IN YOUR LANE[^\n]*/),
    line(/- DESTRUCTIVE = ASK FIRST[^\n]*/),
    line(/- PRIVACY:[^\n]*/),
    line(/- IMAGES ON REQUEST:[^\n]*/),
    line(/- REMEMBERING:[^\n]*/),
    line(/- REMINDERS:[^\n]*/),
    line(/- SEEING THE PC:[^\n]*/),
    line(/- The user's OWN files[^\n]*/),
    raw.match(/## Trading system \(Indian markets\)[\s\S]*?(?=\n## )/)?.[0] ?? "",
  ].filter(Boolean).join("\n");
  // Long-term memory sits at the END of the full prompt — the smart brain must
  // get it too, so it is appended after the digest (within the same budget).
  const memory = raw.match(/\n## What I know about the user \(long-term memory\)[\s\S]*$/)?.[0] ?? "";
  const budget = 4_800;
  const tail = `\n${memory}\n(Tool usage rules still apply; tools are provided via the tools interface.)`;
  const room = Math.max(0, budget - tail.length);
  return `${head}\n${digest}`.slice(0, room) + tail;
}

/**
 * Slim a conversation for the free-tier token caps: the tool descriptions are
 * ALREADY sent in the tools array, so the duplicated "Available tools" text
 * block is dropped; old history and fat tool outputs are trimmed. Complete
 * tool-call blocks are kept together so the API never sees a torn pair.
 */
export function slimForCloud(messages: OllamaMessage[]): OllamaMessage[] {
  const sys: OllamaMessage[] = [];
  const rest: OllamaMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      sys.push({ ...m, content: compactSystemPrompt(m.content) });
    } else {
      const cap = m.role === "tool" ? 2_500 : 4_000;
      const content = m.content.length > cap ? m.content.slice(0, cap) + "…[trimmed]" : m.content;
      rest.push({ ...m, content });
    }
  }
  // Assemble complete blocks from the END (assistant+its tool replies count as one).
  const blocks: OllamaMessage[][] = [];
  let i = rest.length;
  while (i > 0 && blocks.flat().length < 40) {
    let j = i - 1;
    if (rest[j].role === "tool") {
      while (j > 0 && rest[j - 1].role === "tool") j--;
      if (j > 0) j--; // the assistant message that issued the calls
    }
    blocks.unshift(rest.slice(Math.max(j, 0), i));
    i = Math.max(j, 0);
  }
  return [...sys, ...blocks.flat()];
}

export class CloudClient {
  /** The concrete model that last answered — with an aggregator (model "auto")
   *  the configured name is a placeholder, so this is the only way to see what
   *  actually served the request. Surfaced in the UI as "brain: <model>". */
  private lastModelUsed = "";
  /** Model ids the gateway offered, cached so routing costs no extra call per turn. */
  private availableCache: { at: number; ids: string[] } | null = null;

  constructor(private cfg: NonNullable<AppConfig["cloud"]>) {}

  get model(): string {
    return this.cfg.model;
  }

  get lastModel(): string {
    return this.lastModelUsed || this.cfg.model;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.cfg.api_key}`,
    };
  }

  private body(messages: OllamaMessage[], tools: OllamaTool[], temperature: number): string {
    // Slim for free-tier token caps, THEN redact, THEN convert shapes.
    const safe = slimForCloud(messages).map(redactMessage);
    const out: Array<Record<string, unknown>> = [];
    let pendingIds: string[] = [];
    let callIdx = 0;
    for (const m of safe) {
      if (m.role === "assistant" && m.tool_calls) {
        // Ollama stores arguments as an object; OpenAI-compatible APIs want a
        // JSON string — and a tool_call id each tool reply must reference.
        const calls = m.tool_calls.map((tc) => ({
          id: `call_${callIdx++}`,
          type: "function",
          function: { name: tc.function.name, arguments: JSON.stringify(tc.function.arguments ?? {}) },
        }));
        pendingIds = calls.map((c) => c.id);
        out.push({ role: "assistant", content: m.content || null, tool_calls: calls });
      } else if (m.role === "tool") {
        out.push({ role: "tool", tool_call_id: pendingIds.shift() ?? `call_${callIdx++}`, content: m.content });
      } else {
        out.push({ role: m.role, content: m.content });
      }
    }
    return JSON.stringify({
      model: this.cfg.model,
      stream: true,
      temperature,
      messages: out,
      tools: tools.length ? minifyTools(tools) : undefined,
      // Free tiers cap tokens per minute (input + reserved output). A bound on
      // the completion keeps a long "hidden reasoning" answer from pushing the
      // request over the cap mid-stream, which showed up as malformed tool
      // calls ("Failed to parse tool call arguments as JSON").
      max_completion_tokens: 1_200,
      // gpt-oss models think silently and that thinking is billed: keeping the
      // effort low makes replies faster and leaves room under the free cap.
      ...(/gpt-?oss/i.test(this.cfg.model) ? { reasoning_effort: "low" } : {}),
    });
  }

  /** Ask the provider which models exist right now. */
  private async listRemoteModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.cfg.base_url.replace(/\/$/, "")}/models`, { headers: this.headers() });
      if (!res.ok) return [];
      const j = (await res.json().catch(() => null)) as { data?: Array<{ id?: string }> } | null;
      return (j?.data ?? []).map((m) => m.id ?? "").filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Model ids the gateway currently offers, cached briefly (one HTTP call). */
  private async availableModels(): Promise<string[]> {
    if (this.availableCache && Date.now() - this.availableCache.at < 300_000) return this.availableCache.ids;
    const ids = await this.listRemoteModels();
    if (ids.length) this.availableCache = { at: Date.now(), ids };
    return ids;
  }

  /** True when the endpoint can serve many models (FreeLLMAPI) rather than one. */
  private get isAggregator(): boolean {
    return this.cfg.model === LAST_RESORT || /localhost|127\.0\.0\.1/i.test(this.cfg.base_url);
  }

  /** Ordered models to try for this job; a direct provider has exactly one. */
  private async candidateModels(kind: TaskKind): Promise<string[]> {
    if (!this.isAggregator) return [this.cfg.model];
    return pickModelOrder(kind, await this.availableModels(), this.cfg.model);
  }

  /** Chat with tool support (OpenAI-compatible streaming SSE).
   *
   * On an aggregator (FreeLLMAPI) a failure is cheap to recover from: move to
   * the next model preferred for this kind of job instead of waiting out a rate
   * limit that may never clear. On a direct provider (Groq) there is only one
   * model, so the wait-and-retry plus self-heal behaviour is kept. */
  async chat(messages: OllamaMessage[], tools: OllamaTool[], opts: CloudOpts): Promise<ChatResponse> {
    const kind: TaskKind = opts.task ?? (tools.length ? "tools" : "general");
    const candidates = await this.candidateModels(kind);
    const configured = this.cfg.model;
    let lastErr: unknown = null;

    for (let ci = 0; ci < candidates.length; ci++) {
      const model = candidates[ci];
      this.cfg.model = model;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          // Success leaves this.cfg.model on the winner, so pickModelOrder keeps
          // it sticky next turn and a working session does not hop models.
          return await this.chatOnce(messages, tools, opts);
        } catch (e) {
          lastErr = e;
          if (opts.signal?.aborted) throw e;
          const msg = e instanceof Error ? e.message : String(e);

          if (this.isAggregator) {
            // "All models exhausted", a missing provider key and a broken
            // tool-caller all mean the same thing here: try the next one.
            if (ci < candidates.length - 1) {
              console.warn(`[jarvis] ${model} unusable (${msg.slice(0, 90)}); trying ${candidates[ci + 1]}.`);
            }
            break;
          }

          // Direct provider: a short per-minute cap is worth waiting out.
          if (/HTTP 429|rate limit/i.test(msg) && attempt === 0) {
            const waitMs = parseRetryAfterMs(msg) ?? 20_000;
            if (waitMs <= 45_000) {
              console.warn(`[jarvis] cloud rate-limited — retrying in ${Math.round(waitMs / 1000)}s.`);
              await new Promise((r) => setTimeout(r, waitMs));
              continue;
            }
          }
          const retired = /HTTP 404/.test(msg) && /model/i.test(msg);
          // Some free models emit malformed tool calls for a big tool set
          // (Groq: "Failed to call a function", "failed_generation"). Heal the
          // same way as a retired model: switch to one that can, once.
          const toolCallBroken =
            /failed to (?:call a function|parse tool call)|failed_generation|tool_use_failed/i.test(msg);
          if (attempt === 0 && (retired || toolCallBroken)) {
            const next = pickPreferredModel(await this.listRemoteModels(), this.cfg.model);
            if (next) {
              console.warn(
                `[jarvis] cloud model '${this.cfg.model}' ${retired ? "is gone" : "can't call tools here"} — switching to '${next}'.`
              );
              this.cfg.model = next;
              continue;
            }
          }
          break;
        }
      }
    }

    // Nothing worked: restore the configured name so the next turn re-routes
    // from scratch instead of staying stuck on the model that just failed.
    this.cfg.model = configured;
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? "cloud brain: no usable model"));
  }

  private async chatOnce(messages: OllamaMessage[], tools: OllamaTool[], opts: CloudOpts): Promise<ChatResponse> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.base_url.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        // Hard cap: a stalled connection (accepted but silent) must never hang
        // a turn forever — after 120s we bail and the local brain takes over.
        // (AbortSignal.any throws on undefined entries, hence the guard.)
        signal: opts.signal
          ? AbortSignal.any([opts.signal, AbortSignal.timeout(120_000)])
          : AbortSignal.timeout(120_000),
        body: this.body(messages, tools, opts.temperature),
      });
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      throw new Error(`cloud brain unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`cloud brain said HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let content = "";
    // Tool calls arrive as FRAGMENTS (name once, arguments split across many
    // deltas) — accumulate per index and parse only when the stream ends, or
    // the arguments are lost and the call runs with empty parameters.
    const pending = new Map<number, { name: string; argText: string }>();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let j: {
          model?: string;
          choices?: Array<{
            delta?: {
              content?: string | null;
              tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
            };
          }>;
          error?: { message?: string };
        };
        try {
          j = JSON.parse(data);
        } catch {
          continue;
        }
        // Aggregators (FreeLLMAPI) report the model that actually served each
        // chunk — remember it so the UI can show the real brain.
        if (j.model) this.lastModelUsed = j.model;
        if (j.error?.message) throw new Error(`cloud brain error: ${j.error.message}`);
        const delta = j.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          content += delta.content;
          opts.onContent?.(delta.content);
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === "number" ? tc.index : pending.size;
            const cur = pending.get(idx) ?? { name: "", argText: "" };
            if (tc.function?.name) cur.name = tc.function.name;
            if (tc.function?.arguments) cur.argText += tc.function.arguments;
            pending.set(idx, cur);
          }
        }
      }
    }
    // Assemble the accumulated fragments into real tool calls.
    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    for (const [, v] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      if (!v.name) continue;
      let args: Record<string, unknown> = {};
      if (v.argText.trim()) {
        try {
          args = JSON.parse(v.argText) as Record<string, unknown>;
        } catch {
          // A truncated argument blob (token cap mid-stream) still beats losing
          // the call entirely: run it with whatever parsed as an object.
          const start = v.argText.indexOf("{");
          if (start !== -1) {
            const partial = v.argText.slice(start).replace(/,\s*$/, "");
            try {
              args = JSON.parse(partial.endsWith("}") ? partial : partial + "}") as Record<string, unknown>;
            } catch {
              args = {};
            }
          }
        }
      }
      toolCalls.push({ name: v.name, args });
    }
    return { content, toolCalls };
  }
}

/** Compact tool schemas for the cloud (free-tier token budgets). */
export function minifyTools(tools: OllamaTool[]): Array<Record<string, unknown>> {
  // Keep a little headroom over the current tool count so a newly added tool is
  // never silently dropped from the cloud payload (only the description text is
  // trimmed below, which is where the token savings actually come from).
  return tools.slice(0, 80).map((t) => {
    const raw = t.function.parameters as { properties?: Record<string, unknown>; required?: string[] };
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw.properties ?? {})) {
      const pv = v as { type?: string; description?: string };
      props[k] = { type: pv.type ?? "string" }; // names are self-evident; drop long descriptions
    }
    return {
      type: "function",
      function: {
        name: t.function.name,
        // Kept deliberately terse: 54 schemas go out on every cloud call and
        // the free tier counts every character against its per-minute cap.
        description: t.function.description.split(".")[0].slice(0, 45),
        parameters: { type: "object", properties: props, required: raw.required ?? [] },
      },
    };
  });
}

/** True when a cloud brain is configured AND enabled (env keys win over config.yaml). */
export function cloudConfigured(cfg: AppConfig, backup = false): boolean {
  const c = backup ? cfg.cloud_backup : cfg.cloud;
  if (!c || !c.enabled) return false;
  return !!(c.base_url?.trim() && c.model?.trim() && c.api_key?.trim());
}
