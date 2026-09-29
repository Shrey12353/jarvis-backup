/**
 * Jarvis Web UI — a local, zero-dependency server that gives the agent a
 * ChatGPT-style interface in your browser. Same brain (Agent), same tools as
 * chat mode. Multi-chat (sidebar history), file attachments (images, PDFs,
 * documents). Nothing leaves the machine.
 *
 *   npm run ui          → http://localhost:3777 (auto-opens your browser)
 */
import http from "node:http";
import { promises as fsp, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { loadConfig, loadDotEnv, resolveWorkspaceCfg, confineToWorkspace, resolveReadRoots, resolveReadablePath } from "../core/config.js";
import { ensureDirs } from "../core/paths.js";
import { initLogging, log } from "../core/logger.js";
import { OllamaClient, isOllamaDownError, ollamaDownMessage, tryStartOllama, waitForOllama } from "../core/ollama.js";
import { CloudClient, cloudConfigured } from "../core/cloud.js";
import { Agent } from "../core/agent.js";
import { addFacts, extractRememberRequests, listFacts, memoryFile, removeFact } from "../core/memory.js";
import {
  addReminder, cancelReminder, dueReminders, firedReminders, listReminders, markFired, parseWhen,
  type Repeat,
} from "../core/reminders.js";
import { logActivity, pruneActivity, readActivity, summarizeToolCall } from "../core/activity.js";
import { describeOrWait, visionCached } from "../core/vision.js";
import { captureScreen } from "../core/pc.js";
import { showNotification } from "../core/notify.js";
import { detectTimezone } from "../core/tz.js";
import { startTelegramBot, pushReminder, readOwnerChatId, readTelegramState } from "../core/telegram.js";
import { buildRegistry } from "../index.js";
import { shutdownBrowser } from "../tools/browser.js";
import { transcribe } from "../voice/stt.js";
import { pcmToWav } from "./wav.js";
import {
  listChats, saveChat, loadChat, deleteChat, renameChat, createChat,
  migrateLegacySession, ensureChatsDir, type ChatMeta,
} from "./chats.js";
import {
  parseMultipart, saveUpload, isImageFile, composeAttachmentContext, type AttachmentInfo, type UploadedFile,
} from "./attachments.js";

const PORT_BASE = 3777;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

/** Approvals for the chat stream currently running (id → resolver). */
const activeApprovals = new Map<string, (ok: boolean) => void>();

/** Abort controller for the chat request currently running (Stop button). */
let activeRun: { controller: AbortController; chatId: string } | null = null;

function attachSse(res: http.ServerResponse): { sse: (event: string, data: unknown) => void } {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // If the user closes the tab (or the network blips) while an answer is
  // streaming, the write throws — that must NEVER take Jarvis down: reminders,
  // the chat and every background job depend on this process staying alive.
  let alive = true;
  res.on("close", () => { alive = false; });
  res.on("error", () => { alive = false; });
  res.socket?.on("error", () => { alive = false; });
  return {
    sse: (event, data) => {
      if (!alive) return;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        alive = false;
      }
    },
  };
}

function readBody(req: http.IncomingMessage, limit = 30 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function main(): Promise<void> {
  await loadDotEnv();
  const cfg = await loadConfig();
  cfg.agent.workspace = resolveWorkspaceCfg(cfg);
  await ensureDirs(cfg.paths.data);
  await ensureChatsDir(cfg.paths.data);
  await migrateLegacySession(cfg.paths.data);
  initLogging(cfg.paths.data);
  // Detect the user's REAL local timezone once (Node's ambient zone resolves
  // to UTC on this Windows setup, which made reminder toasts show UTC times).
  const tzMin = await detectTimezone();
  console.log(
    `[jarvis] local timezone: UTC${tzMin >= 0 ? "+" : "-"}${String(Math.floor(Math.abs(tzMin) / 60)).padStart(2, "0")}:${String(Math.abs(tzMin) % 60).padStart(2, "0")}`,
  );
  void pruneActivity(cfg.paths.data); // keep the activity log folder small

  // Jarvis runs all day (auto-started, hidden) and owns the reminders, so an
  // unexpected error anywhere must be logged — never a silent death.
  process.on("uncaughtException", (e) => {
    void log(`uncaught exception (still running): ${e instanceof Error ? e.stack : String(e)}`, "error").catch(() => {});
  });
  process.on("unhandledRejection", (e) => {
    void log(`unhandled rejection (still running): ${e instanceof Error ? e.stack : String(e)}`, "error").catch(() => {});
  });

  const registry = buildRegistry();
  const ollama = new OllamaClient(cfg.ollama.host);
  const cloud = cloudConfigured(cfg) ? new CloudClient(cfg.cloud!) : null;
  const cloudBackup = cloudConfigured(cfg, true) ? new CloudClient(cfg.cloud_backup!) : null;

  // Brain check. With a cloud key configured, Jarvis can think even before
  // Ollama finishes booting (tools still use the local machine). Ollama is
  // still probed so /api/status can show its state, and it stays the fallback.
  const cloudOk = !!cloud;
  let ollamaOk = true;
  try {
    await ollama.listModels();
  } catch (e) {
    if (isOllamaDownError(e)) {
      console.log("Ollama isn't responding — trying to start it for you...");
      tryStartOllama(); // local fallback + tools that need local models
      ollamaOk = await waitForOllama(ollama, cloudOk ? 8_000 : 45_000, 2_000);
      if (!ollamaOk && !cloudOk) console.log("\n" + ollamaDownMessage(cfg.ollama.host) + "\n");
    } else {
      throw e;
    }
  }
  const brainOk = cloudOk || ollamaOk;

  // Active chat: a file under data/sessions/chats/. On boot, resume the most
  // recent conversation so the sidebar and the thread agree.
  const chats = await listChats(cfg.paths.data);
  let activeChatId = chats[0]?.id ?? (await createChat(cfg.paths.data));
  let agent = await makeAgent(activeChatId);
  let busy = false;

  // Speed: without keep_alive Ollama unloads the model after ~5 idle minutes
  // and the next message pays a slow reload. Every chat now sends
  // keep_alive=30m; this background warm-up also pre-loads the weights right
  // at startup so the first message is fast too.
  if (ollamaOk) {
    const warmModel = cfg.ollama.model;
    ollama
      .chat(warmModel, [{ role: "user", content: "ping" }], [], { temperature: 0, num_ctx: 512 })
      .then(() => console.log(`[jarvis] local brain '${warmModel}' warm (stays loaded 30m).`))
      .catch(() => {}); // purely a speed optimization — never block startup
  }

  async function makeAgent(chatId: string): Promise<Agent> {
    const agent = new Agent(cfg, registry, chatFilePath(cfg.paths.data, chatId), { dataDir: cfg.paths.data });
    const existing = await loadChat(cfg.paths.data, chatId);
    if (existing) {
      await agent.loadSession(); // loads + tidies from the same file
    } else {
      await agent.reset(); // fresh chat: write system prompt
    }
    return agent;
  }

  // Telegram bot (optional): set TELEGRAM_BOT_TOKEN in .env to enable. The
  // phone gets its own chat session and shares the same brain, tools and
  // approval rules; fired reminders are pushed to the owner's phone too.
  const tgToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (tgToken) {
    const botAgent = async () => {
      const botChatPath = chatFilePath(cfg.paths.data, "telegram-bot");
      const agent = new Agent(cfg, registry, botChatPath, { dataDir: cfg.paths.data });
      if (await loadChat(cfg.paths.data, "telegram-bot")) {
        await agent.loadSession();
      } else {
        await agent.reset();
      }
      return agent;
    };
    void startTelegramBot({ token: tgToken, makeAgent: botAgent, dataDir: cfg.paths.data, log });
  }

  async function handleChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (busy) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Jarvis is already working on a request — wait for it to finish." }));
      return;
    }
    busy = true;
    const controller = new AbortController();
    activeRun = { controller, chatId: "" };
    const sse = attachSse(res);
    // Watchdog: a wedged tool (stalled browser/Ollama call) once kept `busy`
    // true for many minutes and made the UI look hung. Abort the run after a
    // generous 10-minute ceiling — long trading scans fit, dead runs don't.
    const watchdog = setTimeout(() => {
      if (activeRun === null) return;
      void log("chat watchdog: run exceeded 10m — aborting", "warn").catch(() => {});
      controller.abort();
    }, 10 * 60_000);
    try {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}") as {
        message?: string;
        chatId?: string;
        attachmentContext?: string;
      };
      let message = (body.message ?? "").trim();
      if (typeof body.chatId === "string" && body.chatId !== activeChatId) {
        activeChatId = body.chatId;
        agent = await makeAgent(activeChatId);
      }
      if (activeRun) activeRun.chatId = activeChatId;
      const attachNote = (body.attachmentContext ?? "").trim();
      if (attachNote) message = attachNote + (message ? `\n\nUser's question: ${message}` : "");
      if (!message) { sse.sse("error", { message: "Empty message." }); return; }
      if (!brainOk) { sse.sse("error", { message: ollamaDownMessage(cfg.ollama.host) }); return; }

      // "remember ..." is saved deterministically (a model may just answer
      // "noted" without ever calling the remember tool). No note is appended to
      // the user's message: the agent re-reads memory before every pass, so the
      // fact is already in its prompt — and the chat stays clean for the user.
      const asked = extractRememberRequests(message);
      if (asked.length) {
        const added = await addFacts(cfg.paths.data, asked).catch(() => 0);
        if (added) {
          sse.sse("progress", { name: "remember", message: `saved to memory: ${asked.join("; ")}` });
          void logActivity(cfg.paths.data, "remember", `saved a fact about you: ${asked.join("; ")}`, true);
        }
      }

      // Approval cards: each pending ask gets an id the UI can approve/deny.
      const confirm = (action: string, description: string): Promise<boolean> => {
        if (cfg.agent.full_auto && !description.startsWith("[DANGEROUS]")) return Promise.resolve(true);
        return new Promise((resolve) => {
          const id = randomUUID();
          activeApprovals.set(id, (ok) => {
            activeApprovals.delete(id);
            resolve(ok);
          });
          sse.sse("approval_request", { id, action, description });
        });
      };

      // Remember each tool's arguments so the activity log can describe it in
      // plain language once the result comes back.
      const toolArgs = new Map<string, Record<string, unknown>>();
      const result = await agent.run(message, {
        confirm,
        signal: controller.signal, // Stop button support
        finalOnly: true, // the UI shows one quiet activity line — no interim narration
        onContent: (d) => sse.sse("content", { delta: d }),
        onToolCall: (name, args) => {
          toolArgs.set(name, args);
          sse.sse("tool_call", { name, args });
        },
        // Live progress for long jobs (scans, backtests) — the UI shows it as a
        // moving progress line so nothing ever looks stuck.
        onToolProgress: (name, message) => sse.sse("progress", { name, message }),
        onToolResult: (name, rr, ok) => {
          sse.sse("tool_result", { name, ok, excerpt: rr.split("\n")[0].slice(0, 220) });
          void logActivity(cfg.paths.data, name, summarizeToolCall(name, toolArgs.get(name) ?? {}), ok);
        },
      });
      await saveChat(cfg.paths.data, activeChatId, await agent.history());
      sse.sse("done", { answer: result.answer });
      // Learn durable facts from the exchange in the background (local model,
      // never blocks the reply, at most one run every few minutes).
      void maybeLearnFacts(message, result.answer);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await log(`ui chat error: ${msg}`, "error").catch(() => {});
      sse.sse("error", { message: msg });
    } finally {
      clearTimeout(watchdog);
      for (const [, resolve] of activeApprovals) resolve(false);
      activeApprovals.clear();
      activeRun = null;
      busy = false;
      try {
        res.end();
      } catch {
        /* the client already went away — nothing to close */
      }
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "POST" && url.pathname === "/api/chat") return await handleChat(req, res);

      if (req.method === "POST" && url.pathname === "/api/stop") {
        if (activeRun) {
          activeRun.controller.abort();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, note: "nothing running" }));
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/approve") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}") as { id?: string; decision?: boolean };
        const resolve = activeApprovals.get(body.id ?? "");
        if (resolve) resolve(!!body.decision);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: !!resolve }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/upload") {
        const ct = req.headers["content-type"] ?? "";
        if (!/multipart\/form-data/i.test(ct)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "expected multipart/form-data" }));
          return;
        }
        const body = await readBody(req);
        const { files } = parseMultipart(body, ct);
        if (!files.length) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "no file in upload" }));
          return;
        }
        const saved: AttachmentInfo[] = [];
        const errors: string[] = [];
        const images: Array<{ path: string }> = [];
        for (const f of files) {
          try {
            const info = await saveUpload(f, cfg.agent.workspace);
            saved.push(info);
            if (info.kind === "image") images.push({ path: info.path });
          } catch (e) {
            errors.push(`${f.filename}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        // Images: shrink them first (a 4K screenshot doesn't need to be 4K to
        // be understood) and read them in the BACKGROUND — the browser waits at
        // most a few seconds, and anything slower streams in via describe_image.
        let visionNote: string | null = null;
        let visionMissing = false;
        let visionPending = false;
        const configured = (cfg.ollama.vision_model || "").trim();
        if (images.length) {
          if (configured && brainOk) {
            const notes: string[] = [];
            const imgStart = Date.now();
            for (const img of images.slice(0, 3)) {
              const abs = path.join(cfg.agent.workspace, img.path);
              let cached = visionCached(abs);
              if (!cached) {
                const budgetLeft = Math.max(0, 5_000 - (Date.now() - imgStart));
                const waited = await describeOrWait(abs, configured, cfg.ollama.host, budgetLeft, { dataDir: cfg.paths.data });
                cached = waited.result;
                if (waited.pending) visionPending = true;
              }
              if (cached?.text) notes.push(cached.text);
              else if (cached?.error) notes.push(`(could not read the image: ${cached.error})`);
              else if (visionPending) notes.push(`[Still reading this image — call describe_image with path "${img.path}" if you need to see it.]`);
            }
            visionNote = notes.join("\n\n") || null;
          } else {
            visionMissing = true;
            visionNote = "(no vision model installed — Jarvis can offer to install one)";
          }
        }
        // The context the model will see — file names plus the actual content
        // (extracted text, image description) so it never asks the user for paths.
        const attachmentContext = composeAttachmentContext(saved, visionNote);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ saved, errors, visionNote, visionMissing, visionPending, attachmentContext }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/serve-attachment") {
        const rel = url.searchParams.get("path") ?? "";
        const abs = confineToWorkspace(rel, cfg.agent.workspace);
        if (!abs || !existsSync(abs)) { res.writeHead(404); res.end("not found"); return; }
        const types: Record<string, string> = {
          ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
          ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
        };
        res.writeHead(200, { "Content-Type": types[path.extname(abs).toLowerCase()] ?? "application/octet-stream" });
        res.end(await fsp.readFile(abs));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/chats") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ chats: await listChats(cfg.paths.data), active: activeChatId }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/chats/new") {
        if (busy) { res.writeHead(409, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "busy" })); return; }
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}") as { title?: string };
        const fresh = await createChat(cfg.paths.data);
        // Save immediately (empty) so the new chat shows up in the sidebar.
        await saveChat(cfg.paths.data, fresh, [], body.title);
        activeChatId = fresh;
        agent = await makeAgent(fresh);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, id: fresh }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/chats/switch") {
        if (busy) { res.writeHead(409, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "busy" })); return; }
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}") as { id?: string };
        const msgs = await loadChat(cfg.paths.data, String(body.id ?? ""));
        if (!msgs) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "chat not found" })); return; }
        activeChatId = String(body.id);
        agent = await makeAgent(activeChatId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, messages: toUiMessages(msgs) }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/chats/delete") {
        if (busy) { res.writeHead(409, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "busy" })); return; }
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}") as { id?: string };
        const ok = await deleteChat(cfg.paths.data, String(body.id ?? ""));
        if (!ok) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "chat not found" })); return; }
        if (String(body.id) === activeChatId) {
          const rest = await listChats(cfg.paths.data);
          activeChatId = rest[0]?.id ?? (await createChat(cfg.paths.data));
          agent = await makeAgent(activeChatId);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, active: activeChatId }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/chats/rename") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}") as { id?: string; title?: string };
        const ok = await renameChat(cfg.paths.data, String(body.id ?? ""), String(body.title ?? ""));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/history") {
        const msgs = toUiMessages(await agent.history());
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ messages: msgs, chatId: activeChatId }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          model: cfg.ollama.model,
          host: cfg.ollama.host,
          workspace: cfg.agent.workspace,
          fullAuto: cfg.agent.full_auto,
          brainOk,
          cloud: cloud ? { model: cfg.cloud!.model } : null,
          backupCloud: !!cloudBackup,
          busy,
          visionModel: (cfg.ollama.vision_model || "").trim(),
          memoryCount: (await listFacts(cfg.paths.data)).length,
          telegram: await readTelegramState(cfg.paths.data),
        }));
        return;
      }

      // ---------- long-term memory (what Jarvis knows about you) ----------
      if (req.method === "GET" && url.pathname === "/api/memory") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ facts: await listFacts(cfg.paths.data), file: memoryFile(cfg.paths.data) }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/memory/add") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}") as { text?: string };
        const added = await addFacts(cfg.paths.data, [String(body.text ?? "")]);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: added > 0, facts: await listFacts(cfg.paths.data) }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/memory/delete") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}") as { text?: string };
        const ok = await removeFact(cfg.paths.data, String(body.text ?? ""));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok, facts: await listFacts(cfg.paths.data) }));
        return;
      }

      // ---------- reminders ----------
      if (req.method === "GET" && url.pathname === "/api/reminders") {
        const since = Number(url.searchParams.get("since") ?? 0);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          upcoming: await listReminders(cfg.paths.data),
          fired: await firedReminders(cfg.paths.data, since || undefined),
        }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/reminders/add") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}") as { text?: string; when?: string; repeat?: string };
        const when = parseWhen(String(body.when ?? ""));
        const text = String(body.text ?? "").trim();
        if (!text || !when) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "I need what to remind you about and a valid time." }));
          return;
        }
        const repeat = (["none", "daily", "weekdays", "weekly"] as Repeat[]).includes(body.repeat as Repeat)
          ? (body.repeat as Repeat)
          : "none";
        const item = await addReminder(cfg.paths.data, { text, when, repeat });
        void logActivity(cfg.paths.data, "reminder", `set a reminder: ${text}`, true);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, reminder: item, upcoming: await listReminders(cfg.paths.data) }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/reminders/cancel") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}") as { id?: string };
        const gone = await cancelReminder(cfg.paths.data, String(body.id ?? ""));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: !!gone, upcoming: await listReminders(cfg.paths.data) }));
        return;
      }

      // ---------- is the vision model finished reading an image yet? ----------
      if (req.method === "GET" && url.pathname === "/api/vision") {
        const rel = url.searchParams.get("path") ?? "";
        const abs = resolveReadablePath(rel, cfg.agent.workspace, resolveReadRoots(cfg));
        if (!abs || !existsSync(abs)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "image not found" }));
          return;
        }
        const configured = (cfg.ollama.vision_model || "").trim();
        if (!configured) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ text: null, error: "no vision model is installed" }));
          return;
        }
        const cached = visionCached(abs);
        if (cached?.text) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ text: cached.text, pending: false }));
          return;
        }
        // Starts (or joins) the background job without waiting for it.
        const { result, pending } = await describeOrWait(abs, configured, cfg.ollama.host, 0, {
          dataDir: cfg.paths.data,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text: result?.text ?? null, error: result?.error ?? null, pending }));
        return;
      }

      // ---------- activity: what did Jarvis actually do ----------
      if (req.method === "GET" && url.pathname === "/api/activity") {
        const day = url.searchParams.get("day") ?? new Date().toISOString().slice(0, 10);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ day, entries: await readActivity(cfg.paths.data, day) }));
        return;
      }

      // ---------- "use my screen": screenshot + read it aloud ----------
      if (req.method === "POST" && url.pathname === "/api/screen") {
        try {
          const abs = await captureScreen(cfg.agent.workspace);
          const rel = path.relative(cfg.agent.workspace, abs).split(path.sep).join("/");
          const info: AttachmentInfo = { name: path.basename(abs), kind: "image", path: rel };
          const configured = (cfg.ollama.vision_model || "").trim();
          let note: string | null = null;
          let pending = false;
          if (configured && brainOk) {
            // Start reading it now, but DON'T make the user wait: the UI shows
            // the screenshot immediately and polls /api/vision until the
            // description is ready (a few seconds on this CPU).
            const { result, pending: stillReading } = await describeOrWait(abs, configured, cfg.ollama.host, 2_000, {
              dataDir: cfg.paths.data,
              maxDim: 900,
            });
            note = result?.text || null;
            pending = !note && stillReading;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              saved: [info],
              visionNote: note,
              visionPending: pending,
              attachmentContext: composeAttachmentContext([info], note),
            })
          );
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/voice") {
        // Raw 16 kHz mono PCM from the browser → WAV → whisper.cpp → text.
        const pcm = await readBody(req);
        const wavPath = path.join(cfg.paths.data, "voice", `ui-${Date.now()}.wav`);
        await fsp.mkdir(path.dirname(wavPath), { recursive: true });
        await fsp.writeFile(wavPath, pcmToWav(pcm, 16000));
        let text = "";
        try { text = (await transcribe(wavPath, cfg.voice)).trim(); } catch (e) {
          text = `STT error: ${e instanceof Error ? e.message : String(e)}`;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text }));
        return;
      }

      // Static files (the single-page UI)
      const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
      const file = path.join(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) {
        res.writeHead(404); res.end("not found"); return;
      }
      const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
      res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" });
      res.end(await fsp.readFile(file));
    } catch (e) {
      await log(`ui server error: ${e instanceof Error ? e.message : String(e)}`, "error").catch(() => {});
      if (!res.headersSent) { res.writeHead(500); res.end("server error"); }
    }
  });

  /**
   * Background fact-learning: after a personal-sounding exchange, ask the LOCAL
   * model for 1-3 durable facts and store them. Free, private, and it never
   * delays an answer. Quiet on every failure — memory is a bonus, not a risk.
   */
  let lastExtractAt = 0;
  async function maybeLearnFacts(userText: string, answer: string): Promise<void> {
    if (!ollamaOk || !brainOk) return;
    if (Date.now() - lastExtractAt < 180_000) return; // at most once per 3 min
    const personal = /\b(my name|i am|i'm|i live|i work|i study|i run|i own|i prefer|i like|i always|i never|my (goal|target|plan|business|exam|class|job|work|family|wife|husband|son|daughter|brother|sister|father|mother|city|age|birthday|anniversary))\b/i;
    if (!personal.test(userText)) return;
    lastExtractAt = Date.now();
    try {
      const client = new OllamaClient(cfg.ollama.host);
      const res = await client.chat(
        cfg.ollama.model,
        [
          {
            role: "system",
            content:
              'You extract durable facts about the USER from a conversation. Answer with ONLY a JSON array, e.g. ["Lives in Mumbai","Studies for CA Final"]. Max 3 facts, each under 100 characters, third person, no quotes inside. Use [] when there is nothing durable (one-off questions, weather, temporary things).',
          },
          { role: "user", content: `User said: ${userText.slice(0, 1_200)}\n\nAssistant answered: ${answer.slice(0, 800)}` },
        ],
        [],
        { temperature: 0, num_ctx: 4_096 }
      );
      // The model answers with a JSON array (possibly wrapped in prose/fences).
      const text = res.content.trim();
      const start = text.indexOf("[");
      const end = text.lastIndexOf("]");
      let parsed: unknown = [];
      try {
        parsed = start !== -1 && end > start ? JSON.parse(text.slice(start, end + 1)) : [];
      } catch {
        parsed = [];
      }
      const facts = (Array.isArray(parsed) ? parsed : []).filter((f): f is string => typeof f === "string");
      const added = await addFacts(cfg.paths.data, facts.slice(0, 3));
      if (added) console.log(`[jarvis] learned ${added} new fact(s) about the user`);
    } catch {
      /* the learned-facts pass is strictly best-effort */
    }
  }

  // Reminder ticker: fires due reminders as a Windows toast (plus a note in the
  // chat, which the UI picks up by polling). Works whenever Jarvis is running,
  // including the hidden auto-start, so reminders survive restarts.
  const tick = async (): Promise<void> => {
    try {
      for (const r of await dueReminders(cfg.paths.data)) {
        await showNotification(r.text, "Jarvis reminder");
        // Mirror the reminder to the owner's phone when Telegram is linked.
        const tgToken2 = process.env.TELEGRAM_BOT_TOKEN?.trim();
        if (tgToken2) {
          const owner = await readOwnerChatId(cfg.paths.data);
          if (owner) void pushReminder(tgToken2, owner, r.text);
        }
        await markFired(cfg.paths.data, r.id);
        await logActivity(cfg.paths.data, "reminder", `reminded you: ${r.text}`, true);
        console.log(`[jarvis] reminder fired: ${r.text}`);
      }
    } catch (e) {
      await log(`reminder ticker error: ${e instanceof Error ? e.message : String(e)}`, "warn").catch(() => {});
    }
  };
  const reminderTicker = setInterval(() => void tick(), 20_000);
  reminderTicker.unref?.();
  void tick();

  const port = await listenOnFreePort(server, PORT_BASE);
  console.log(`Jarvis UI ready →  http://localhost:${port}`);
  const brainLine = cloud
    ? `brain: CLOUD ${cfg.cloud!.model} (local Ollama ${ollamaOk ? "standby" : "starting"})`
    : `model: ${cfg.ollama.model} | brain: ${brainOk ? "ok" : "UNREACHABLE"}`;
  console.log(`workspace: ${cfg.agent.workspace} | ${brainLine}`);
  if (process.env.JARVIS_UI_OPEN !== "0") {
    const { spawn } = await import("node:child_process");
    if (process.platform === "win32") {
      spawn("cmd.exe", ["/c", "start", "", `http://localhost:${port}`], { detached: true, stdio: "ignore", shell: true }).unref();
    }
  }
  void shutdownBrowser;
}

/** Messages as the UI renders them (system + tool noise stripped, attachments included). */
function toUiMessages(msgs: Awaited<ReturnType<Agent["history"]>>): Array<{ role: string; content: string }> {
  return msgs
    .filter((m) => m.role === "user" || (m.role === "assistant" && m.content.trim()))
    .map((m) => ({ role: m.role, content: m.content }));
}

function chatFilePath(dataDir: string, id: string): string {
  return path.join(dataDir, "sessions", "chats", `${id}.json`);
}

main().catch(async (e) => {
  console.error("fatal:", e);
  await log(`ui fatal: ${e instanceof Error ? e.stack : String(e)}`, "error").catch(() => {});
  process.exit(1);
});

function listenOnFreePort(server: http.Server, base: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = base;
    const tryOnce = (): void => {
      server.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE" && port < base + 10) {
          port++;
          server.listen(port);
        } else reject(e);
      });
      server.listen(port, () => resolve(port));
    };
    tryOnce();
  });
}
