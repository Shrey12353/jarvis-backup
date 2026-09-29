/**
 * Telegram bot — Jarvis in your pocket.
 *
 * Long-polls Telegram's API (no inbound ports, works behind NAT), accepts
 * messages ONLY from the owner's chat id (allowlist), and routes them through
 * the SAME Agent brain as the web UI — with its own chat session so phone and
 * PC conversations stay separate. Fired reminders are pushed to the phone.
 * Every tool safety level (ask-cards) applies here exactly as at the PC:
 * anything destructive asks in chat, and the owner types "y" to approve.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { Agent } from "./agent.js";

const API = "https://api.telegram.org";
const MAX_TEXT = 3_500; // Telegram message limit is 4096; stay under it

interface TgUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    text?: string;
    from?: { is_bot?: boolean };
  };
}

async function tgCall(token: string, method: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(45_000), // getUpdates long-polls ~25s; never hang forever
  });
  const j = (await res.json().catch(() => null)) as { ok?: boolean; result?: unknown } | null;
  if (!j?.ok) throw new Error(`telegram ${method} failed: ${JSON.stringify(j).slice(0, 200)}`);
  return j.result;
}

/** Send one chat message, split into chunks if long. Never throws. */
async function sendText(token: string, chatId: number, text: string): Promise<void> {
  const clean = text.replace(/^\s*!\[[^\]]*\]\([^)]*\)\s*$/gm, "").trim() || "(empty reply)";
  for (let i = 0; i < Math.ceil(clean.length / MAX_TEXT); i++) {
    const chunk = clean.slice(i * MAX_TEXT, (i + 1) * MAX_TEXT);
    await tgCall(token, "sendMessage", {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true,
    }).catch(() => {});
  }
}

export interface TelegramBotOptions {
  token: string;
  /** Agent factory — returns the brain bound to the bot's own chat file. */
  makeAgent: () => Promise<Pick<Agent, "run">>;
  /** Where reminder pushes / session files live. */
  dataDir: string;
  log: (line: string, level?: "error" | "info" | "warn") => Promise<void> | void;
}

const STATE_FILE = "telegram-state.json";

export async function startTelegramBot(opts: TelegramBotOptions): Promise<void> {
  const { token, makeAgent, dataDir, log } = opts;
  const statePath = path.join(dataDir, STATE_FILE);

  // Persistent state: owner chat id (learned on first /start) + update cursor.
  let ownerChatId = 0;
  let offset = 0;
  let pairingPin = "";
  try {
    const s = JSON.parse(await fsp.readFile(statePath, "utf8")) as {
      ownerChatId?: number;
      offset?: number;
      pairingPin?: string;
    };
    ownerChatId = s.ownerChatId ?? 0;
    offset = s.offset ?? 0;
    pairingPin = s.pairingPin ?? "";
  } catch {
    /* first run */
  }
  if (!pairingPin) {
    // Stable 6-digit PIN lets the owner re-link a new phone/account with
    // "/link <pin>" — no PC access needed. Stored locally; shown in the boot
    // log and the /api/status payload.
    pairingPin = String(Math.floor(100_000 + Math.random() * 900_000));
  }
  const saveState = async () => {
    await fsp.writeFile(statePath, JSON.stringify({ ownerChatId, offset, pairingPin }), "utf8").catch(() => {});
  };
  await saveState();

  let busy = false; // one brain run at a time — same guard as the web UI
  const pending = new Map<number, (ok: boolean) => void>(); // approval promises

  await log(
    `[jarvis] telegram bot polling (owner: ${ownerChatId ? `linked ${ownerChatId}` : "awaiting /start"}; re-link PIN: ${pairingPin})`,
  );

  for (;;) {
    try {
      const updates = (await tgCall(token, "getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message"],
      })) as TgUpdate[];

      for (const u of updates) {
        offset = u.update_id + 1;
        const msg = u.message;
        if (!msg?.text) continue;
        const chatId = msg.chat.id;

        // Ownership: unlinked -> any human /start claims the bot. Linked -> a
        // matching "/link <pin>" from another chat MOVES ownership there (new
        // phone/account), wrong pin gets the same generic stranger reply so
        // probing reveals nothing.
        if (chatId !== ownerChatId) {
          const t = msg.text.trim();
          const pinMatch = /^\/(?:link|start)(?:\s+(\d{6}))?\s*$/.exec(t);
          const pinOk = !!pinMatch && pinMatch[1] === pairingPin;
          const firstStart = !ownerChatId && /^\/start\b/.test(t) && !msg.from?.is_bot;
          if (pinOk || firstStart) {
            const was = ownerChatId;
            ownerChatId = chatId;
            await saveState();
            await sendText(
              token,
              chatId,
              was
                ? "Re-linked! This chat now talks to your Jarvis (the previous chat was released). Reminders will push here too."
                : "Linked! This phone now talks to your Jarvis. Try: 'what's on today?' or 'remind me in 10 minutes to stretch'. Only this chat can control him.",
            );
          } else {
            await sendText(token, chatId, ownerChatId ? "This bot belongs to someone else." : "Send /start to claim this bot.").catch(() => {});
          }
          continue;
        }

        const text = msg.text.trim();

        // Approval replies (y / yes / n / no) resolve a pending ask-card.
        if (pending.size && /^(y|yes|n|no)\b/i.test(text)) {
          const ok = /^y/i.test(text);
          for (const [id, resolve] of pending) {
            pending.delete(id);
            resolve(ok);
          }
          await sendText(token, chatId, ok ? "Approved — doing it." : "Denied.");
          continue;
        }

        if (text === "/start" || text === "/help") {
          await sendText(
            token,
            chatId,              [
                "You're talking to your Jarvis (same brain as the PC).",
                "Try: 'what's on today?', 'remind me tomorrow 9am to call X', 'check my email', 'what did you do today?'",
                "Anything destructive asks first — reply y/n.",
                "New phone or new account? Send '/link <6-digit PIN>' from it (PIN is in the PC boot log / status page).",
              ].join("\n"),
          );
          continue;
        }
        if (text === "/stop" && busy) {
          // best effort: a fresh run replaces the loop's busy flag on next poll
          continue;
        }

        if (busy) {
          await sendText(token, chatId, "Still working on your previous request — one at a time.");
          continue;
        }
        busy = true;
        try {
          const agent = await makeAgent();
          const result = await agent.run(text, {
            // Telegram approvals: described in chat, resolved by y/n above.
            confirm: (action: string, description: string) =>
              new Promise<boolean>((resolve) => {
                const id = Date.now();
                pending.set(id, resolve);
                void sendText(token, chatId, `APPROVE? ${action}\n${description}\n\nReply y or n.`).catch(() => {
                  pending.delete(id);
                  resolve(false);
                });
              }),
            finalOnly: true,
          });
          await sendText(token, chatId, result.answer);
        } catch (e) {
          await sendText(token, chatId, `That failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500));
        } finally {
          busy = false;
        }
      }
      if (updates.length) await saveState();
    } catch (e) {
      const msgText = e instanceof Error ? e.message : String(e);
      await log(`[jarvis] telegram poll error: ${msgText.slice(0, 160)}`, "warn");
      await new Promise((r) => setTimeout(r, 5_000)); // back off, then keep polling
    }
  }
}

/** Push a fired reminder to the owner's phone (called by the reminder ticker). */
export async function pushReminder(token: string, ownerChatId: number, text: string): Promise<boolean> {
  if (!ownerChatId) return false;
  try {
    await tgCall(token, "sendMessage", { chat_id: ownerChatId, text: `⏰ ${text}` });
    return true;
  } catch {
    return false;
  }
}

export async function readOwnerChatId(dataDir: string): Promise<number> {
  return (await readTelegramState(dataDir)).ownerChatId;
}

/** Owner chat id + pairing pin (for the status endpoint). */
export async function readTelegramState(dataDir: string): Promise<{ ownerChatId: number; pairingPin: string }> {
  try {
    const s = JSON.parse(await fsp.readFile(path.join(dataDir, STATE_FILE), "utf8")) as {
      ownerChatId?: number;
      pairingPin?: string;
    };
    return { ownerChatId: s.ownerChatId ?? 0, pairingPin: s.pairingPin ?? "" };
  } catch {
    return { ownerChatId: 0, pairingPin: "" };
  }
}
