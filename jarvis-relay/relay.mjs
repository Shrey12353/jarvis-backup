#!/usr/bin/env node
/**
 * JARVIS RELAY — the 24/7 cloud twin.
 *
 * Runs on a tiny Linux VPS (~$5/mo, or any always-on machine) and gives Jarvis
 * an always-on presence:
 *   - Telegram bot: its OWN bot token (create a second bot in BotFather, e.g.
 *     "JarvisCloud"), so it never fights the home bot for updates
 *   - Reminders: stored here, fired on time, pushed to your phone — even while
 *     your PC sleeps. Supports "/remind in 30 minutes ..." plus repeating
 *     daily/weekdays/weekly. Missed while the VPS restarted? Fired on boot.
 *   - Chat: answered by the SAME Groq cloud brain your PC uses. The twin says
 *     honestly that it is the lightweight cloud side (no PC hands).
 *
 * Dependency-free: Node 18+ built-ins only (fetch, fs). Run under systemd with
 * Restart=always for true 24/7. Set TZ=Asia/Kolkata so times are YOUR local.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(HERE, "data.json");
const API = "https://api.telegram.org";
const MODEL = process.env.JARVIS_CLOUD_MODEL || "openai/gpt-oss-20b";
const GROQ_KEY = process.env.JARVIS_CLOUD_API_KEY || "";
const GROQ_URL = (process.env.JARVIS_CLOUD_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, "");
const TICK_MS = 20_000;

// ---------- tiny state layer ----------
const state = { ownerChatId: 0, pairingPin: "", offset: 0, reminders: [], fired: [] };
try {
  Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, "utf8")));
} catch {
  /* first run */
}
if (!state.pairingPin) state.pairingPin = String(Math.floor(100_000 + Math.random() * 900_000));
const save = () => {
  // Keep the reminder list bounded like the PC store.
  state.reminders = state.reminders.filter((r) => !r.done).slice(-100);
  const cutoff = Date.now() - 2 * 86_400_000;
  state.fired = state.fired.filter((f) => Date.parse(f.at) >= cutoff).slice(-40);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
};
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

// ---------- time parsing (owner-local; set TZ in the systemd unit) ----------
const DAY = 86_400_000;
function parseWhen(input, now = new Date()) {
  const s = String(input ?? "").trim();
  if (!s) return null;
  const rel = /^in\s+(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/i.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const ms = /^s/i.test(rel[2]) ? n * 1e3 : /^h/i.test(rel[2]) ? n * 36e5 : n * 6e4;
    return new Date(now.getTime() + ms);
  }
  const clock = /^(tomorrow\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(s);
  if (clock) {
    let h = Number(clock[2]);
    const min = Number(clock[3] ?? 0);
    const ap = (clock[4] ?? "").toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    if (clock[1]) d.setDate(d.getDate() + 1); // explicit "tomorrow"
    else if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1); // past time today = tomorrow
    return d;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})([T ](\d{1,2}):(\d{2}))?/.exec(s);
  if (iso) {
    const d = iso[4]
      ? new Date(+iso[1], +iso[2] - 1, +iso[3], +iso[5], +iso[6])
      : new Date(+iso[1], +iso[2] - 1, +iso[3], 9, 0);
    if (!isNaN(d.getTime())) return d;
  }
  const fallback = new Date(s);
  return isNaN(fallback.getTime()) ? null : fallback;
}
function nextDue(dueAt, repeat, from = new Date()) {
  if (repeat === "none") return null;
  const step = (d) =>
    repeat === "weekly" ? new Date(d.getTime() + 7 * DAY)
    : repeat === "weekdays" ? (() => { let x = new Date(d.getTime() + DAY); while (x.getDay() === 0 || x.getDay() === 6) x = new Date(x.getTime() + DAY); return x; })()
    : new Date(d.getTime() + DAY);
  let next = step(new Date(dueAt));
  let guard = 0;
  while (next.getTime() <= from.getTime() && guard++ < 500) next = step(next);
  return next.toISOString();
}
function fmtDue(iso) {
  const d = new Date(iso);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const h = d.getHours(), h12 = h % 12 === 0 ? 12 : h % 12;
  return `${days[d.getDay()]}, ${d.getDate()} ${d.toLocaleString("en", { month: "short" })}, ${h12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

// ---------- telegram ----------
let TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
async function tg(method, body) {
  const res = await fetch(`${API}/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(45_000),
  });
  const j = await res.json().catch(() => null);
  if (!j?.ok) throw new Error(`${method}: ${JSON.stringify(j).slice(0, 160)}`);
  return j.result;
}
async function send(chatId, text) {
  const t = String(text).slice(0, 3_800) || "(empty)";
  await tg("sendMessage", { chat_id: chatId, text: t, disable_web_page_preview: true }).catch(() => {});
}

// ---------- groq brain ----------
const SYSTEM = `You are Jarvis, the user's personal AI assistant — specifically the cloud side that lives on an always-on server, reachable 24/7 from their phone via Telegram.
Be concise (often read aloud), warm, direct. Plain language, no code unless asked.
You have NO hands here: no PC access, no files, no screen, no email reading. If asked for those, say the home Jarvis on their PC handles that when the PC is on.
You CAN: chat, answer questions, think through problems, and take reminders (the relay handles /remind commands itself — if the user asks in natural language to be reminded, tell them to send it as: /remind in 20 minutes <text> or /remind 9:00am <text>, daily/weekdays/weekly supported).`;

async function think(userText) {
  if (!GROQ_KEY) return "(cloud brain has no API key configured on the relay — set JARVIS_CLOUD_API_KEY in the relay .env)";
  const body = {
    model: MODEL,
    temperature: 0.6,
    max_completion_tokens: 900,
    reasoning_effort: "low",
    messages: [
      { role: "system", content: SYSTEM },
      ...chatHistory.slice(-12),
      { role: "user", content: userText },
    ],
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${GROQ_URL}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${GROQ_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 429 && attempt === 0) {
        await new Promise((r) => setTimeout(r, 15_000));
        continue;
      }
      const j = await res.json();
      const out = j?.choices?.[0]?.message?.content?.trim();
      if (out) return out;
      return `(the cloud brain returned nothing — ${JSON.stringify(j).slice(0, 140)})`;
    } catch (e) {
      if (attempt === 1) return `Cloud brain error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}
const chatHistory = []; // light session memory for the twin
const rememberChat = (role, content) => {
  chatHistory.push({ role, content });
  if (chatHistory.length > 24) chatHistory.splice(0, chatHistory.length - 24);
};

// ---------- reminders ----------
async function reminderTick() {
  const now = Date.now();
  for (const r of state.reminders.filter((r) => !r.done && Date.parse(r.dueAt) <= now)) {
    await send(state.ownerChatId, `⏰ ${r.text}`);
    state.fired.push({ id: r.id, text: r.text, at: new Date().toISOString() });
    const next = nextDue(r.dueAt, r.repeat);
    r.lastFiredAt = new Date().toISOString();
    if (!next) r.done = true;
    else r.dueAt = next;
  }
  save();
}
function addReminder(text, when, repeat) {
  state.reminders.push({
    id: `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    text, dueAt: when.toISOString(), repeat, createdAt: new Date().toISOString(),
  });
  save();
}

// ---------- command handling ----------
async function handle(chatId, text) {
  const t = text.trim();

  // ownership (same protocol as home: first /start claims; /link <pin> moves)
  if (chatId !== state.ownerChatId) {
    const pin = /^\/(?:link|start)(?:\s+(\d{6}))?\s*$/.exec(t);
    if ((pin && pin[1] === state.pairingPin) || (!state.ownerChatId && /^\/start\b/.test(t))) {
      const was = state.ownerChatId;
      state.ownerChatId = chatId;
      save();
      await send(chatId, was
        ? "Re-linked! This is your Jarvis Cloud — 24/7 on my own server. Reminders set here fire even when your PC is asleep."
        : "Linked! This is Jarvis Cloud — your 24/7 Jarvis. Try '/remind in 8 hours take medicines' or just talk to me. Your home Jarvis (PC) stays a separate chat.");
    } else {
      await send(chatId, state.ownerChatId ? "This bot belongs to someone else." : "Send /start to claim this bot.");
    }
    return;
  }

  if (t === "/help" || t === "/start") {
    await send(chatId, [
      "Jarvis Cloud — the 24/7 side (my home twin lives on your PC).",
      "",
      "/remind <when> <text> — reminders that fire even with your PC off.",
      "   /remind in 30 minutes stretch",
      "   /remind 9:00am take medicines daily",
      "   /remind tomorrow 8pm call home",
      "/list — pending reminders   /done <number> — cancel one",
      "",
      "Anything else is just a chat — I answer with the same brain, anywhere you are.",
    ].join("\n"));
    return;
  }

  if (t === "/list") {
    const items = state.reminders.filter((r) => !r.done);
    await send(chatId, items.length
      ? items.map((r, i) => `${i + 1}. ${fmtDue(r.dueAt)}${r.repeat !== "none" ? ` (${r.repeat})` : ""} — ${r.text}`).join("\n")
      : "No pending reminders.");
    return;
  }
  const done = /^\/done\s+(\d+)\s*$/.exec(t);
  if (done) {
    const items = state.reminders.filter((r) => !r.done);
    const r = items[Number(done[1]) - 1];
    if (r) { r.done = true; save(); await send(chatId, `Cancelled: ${r.text}`); }
    else await send(chatId, "No reminder with that number — try /list.");
    return;
  }

  const rem = /^\/remind\s+(?:me\s+)?(.+)$/i.exec(t);
  if (rem) {
    const rest = rem[1];
    const repeatM = /\b(daily|weekdays|weekly)\b/i.exec(rest);
    const repeat = repeatM ? repeatM[1].toLowerCase() : "none";
    const whenStr = rest.replace(/\b(daily|weekdays|weekly)\b/gi, "").trim();
    const when = parseWhen(whenStr);
    if (!when) {
      await send(chatId, "I couldn't read that time. Examples:\n/remind in 20 minutes stretch\n/remind 9:00am take medicines daily");
      return;
    }
    // The time phrase itself is the reminder text if nothing else remains.
    let rtext = whenStr
      .replace(/^in\s+\d+(?:\.\d+)?\s*\w+\s+/i, "")
      .replace(/^\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s+/i, "")
      .replace(/^tomorrow\s+/i, "")
      .trim() || whenStr;
    addReminder(rtext, when, repeat);
    await send(chatId, `Reminder set for ${fmtDue(when.toISOString())}${repeat !== "none" ? `, repeating ${repeat}` : ""}: ${rtext}`);
    return;
  }

  // everything else → the brain
  const answer = await think(t);
  rememberChat("user", t);
  rememberChat("assistant", answer);
  await send(chatId, answer);
}

// ---------- main loops ----------
setInterval(() => reminderTick().catch((e) => log(`tick error: ${e.message}`)), TICK_MS);

log(`Jarvis Relay starting. owner=${state.ownerChatId || "unclaimed"} pin=${state.pairingPin} model=${MODEL}`);
log("Set the owner by sending /start to your cloud bot, or /link <pin> to move it.");

// Fire anything missed while the process was down (true 24/7 catch-up).
await reminderTick();

let backoff = 2_000;
for (;;) {
  try {
    const updates = (await tg("getUpdates", { offset: state.offset, timeout: 25, allowed_updates: ["message"] })) || [];
    backoff = 2_000;
    for (const u of updates) {
      state.offset = u.update_id + 1;
      save();
      const msg = u.message;
      if (msg?.text && !msg.from?.is_bot) await handle(msg.chat.id, msg.text).catch((e) => log(`handle error: ${e.message}`));
    }
  } catch (e) {
    log(`poll error: ${String(e).slice(0, 140)}`);
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 60_000);
  }
}
