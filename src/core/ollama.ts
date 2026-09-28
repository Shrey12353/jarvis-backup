import { spawn, type ChildProcess } from "node:child_process";

export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Ollama tool call shape on assistant messages */
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, unknown> };
  }>;
  images?: string[];
}

export interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface ChatChunk {
  done?: boolean;
  message?: OllamaMessage;
  error?: string;
}

export interface ChatResponse {
  content: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
}

/** True when an error looks like "cannot reach the Ollama server". */
export function isOllamaDownError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.message}` : String(e);
  return /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|socket hang up|can't reach my AI brain/i.test(msg);
}

/** The plain-language message a non-coder should see when the brain is unreachable. */
export function ollamaDownMessage(host: string): string {
  return [
    `I can't reach my AI brain (Ollama) at ${host}.`,
    `This usually means Ollama isn't running yet — it can take a minute after you switch on the PC.`,
    `What you can do:`,
    `  1. Wait a few seconds and try again (I retry automatically at startup).`,
    `  2. If it keeps failing, start "Ollama" from the Start Menu, then try again.`,
    `  3. If Ollama isn't installed, get it from https://ollama.com`,
  ].join("\n");
}

let ollamaProc: ChildProcess | null = null;

/**
 * Try to launch the Ollama server locally (best-effort, Windows + Unix).
 * Detached so it survives this process; harmless if already running.
 */
export function tryStartOllama(): void {
  if (ollamaProc) return;
  try {
    const exe = process.platform === "win32" ? "ollama app.exe" : "ollama";
    const args = process.platform === "win32" ? [] : ["serve"];
    ollamaProc = spawn(exe, args, {
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    ollamaProc.unref();
  } catch {
    /* best effort only */
  }
}

/** Poll the server until it answers, or give up after `timeoutMs`. */
export async function waitForOllama(
  client: OllamaClient,
  timeoutMs = 45_000,
  everyMs = 1_500
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await client.listModels();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, everyMs));
    }
  }
  return false;
}

export class OllamaClient {
  constructor(private host: string) {}

  private url(p: string): string {
    return new URL(p, this.host.endsWith("/") ? this.host : this.host + "/").toString();
  }

  async listModels(): Promise<string[]> {
    let res: Response;
    try {
      res = await fetch(this.url("api/tags"));
    } catch (e) {
      throw new Error(ollamaDownMessage(this.host));
    }
    if (!res.ok) throw new Error(`Ollama not reachable (${res.status})`);
    const json = (await res.json()) as { models?: Array<{ name: string }> };
    return (json.models ?? []).map((m) => m.name);
  }

  async hasModel(model: string): Promise<boolean> {
    const names = await this.listModels();
    return names.some((n) => n === model || n.split(":")[0] === model.split(":")[0]);
  }

  async pull(model: string, onLine?: (line: string) => void): Promise<void> {
    const res = await fetch(this.url("api/pull"), {
      method: "POST",
      body: JSON.stringify({ name: model }),
    });
    if (!res.ok || !res.body) throw new Error(`pull failed: ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const j = JSON.parse(line) as { status?: string; error?: string };
          if (j.error) throw new Error(j.error);
          if (j.status && onLine) onLine(j.status);
        } catch {
          /* ignore non-JSON keepalive lines */
        }
      }
    }
  }

  /** Chat with tools. Streams internally for responsiveness; returns final message parts. */
  async chat(
    model: string,
    messages: OllamaMessage[],
    tools: OllamaTool[],
    opts: { temperature: number; num_ctx: number; onContent?: (delta: string) => void; signal?: AbortSignal }
  ): Promise<ChatResponse> {
    let res: Response;
    try {
      res = await fetch(this.url("api/chat"), {
        method: "POST",
        signal: opts.signal,
        body: JSON.stringify({
          model,
          messages,
          tools: tools.length ? tools : undefined,
          stream: true,
          keep_alive: "30m",
          options: { temperature: opts.temperature, num_ctx: opts.num_ctx },
        }),
      });
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      throw new Error(ollamaDownMessage(this.host));
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama chat failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let content = "";
    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let chunk: ChatChunk;
        try {
          chunk = JSON.parse(line) as ChatChunk;
        } catch {
          continue;
        }
        if (chunk.error) throw new Error(chunk.error);
        const msg = chunk.message;
        if (!msg) continue;
        if (msg.content) {
          content += msg.content;
          opts.onContent?.(msg.content);
        }
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            toolCalls.push({ name: tc.function.name, args: tc.function.arguments ?? {} });
          }
        }
      }
    }
    return { content, toolCalls };
  }
}
