/**
 * Reminders — one-off and repeating, stored on disk so they survive restarts.
 *
 * A small ticker inside the UI server fires them (Windows toast + a note in the
 * chat if the UI is open). The file is plain JSON the user can inspect, and
 * every entry stays local to this PC.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { formatDueLocal, localWallClockToUtc, tzOffsetMinutes } from "./tz.js";

export type Repeat = "none" | "daily" | "weekdays" | "weekly";

export interface Reminder {
  id: string;
  text: string;
  /** ISO timestamp of the next firing (UTC). */
  dueAt: string;
  repeat: Repeat;
  createdAt: string;
  lastFiredAt?: string;
  done?: boolean;
}

export interface FiredReminder {
  id: string;
  text: string;
  at: string;
}

interface Store {
  items: Reminder[];
  fired: FiredReminder[];
}

const MAX_ITEMS = 100;
const FIRED_KEEP_MS = 2 * 24 * 60 * 60 * 1000;

export function remindersFile(dataDir: string): string {
  return path.join(dataDir, "reminders.json");
}

async function readStore(dataDir: string): Promise<Store> {
  try {
    const j = JSON.parse(await fsp.readFile(remindersFile(dataDir), "utf8")) as Partial<Store>;
    return {
      items: Array.isArray(j.items) ? (j.items as Reminder[]) : [],
      fired: Array.isArray(j.fired) ? (j.fired as FiredReminder[]) : [],
    };
  } catch {
    return { items: [], fired: [] };
  }
}

async function writeStore(dataDir: string, store: Store): Promise<void> {
  const file = remindersFile(dataDir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const cutoff = Date.now() - FIRED_KEEP_MS;
  store.fired = store.fired.filter((f) => Date.parse(f.at) >= cutoff).slice(-40);
  await fsp.writeFile(file, JSON.stringify(store, null, 2), "utf8");
}

function newId(): string {
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ================= scheduling math (pure — exported for tests) =================

/** Next occurrence for a repeating reminder, strictly after `from`. null = done. */
export function nextDue(dueAt: string, repeat: Repeat, from: Date): string | null {
  if (repeat === "none") return null;
  const DAY = 24 * 60 * 60 * 1000;
  let next = new Date(dueAt);
  if (isNaN(next.getTime())) return null;
  const stepForward = (d: Date): Date => {
    if (repeat === "weekly") return new Date(d.getTime() + 7 * DAY);
    if (repeat === "weekdays") {
      let x = new Date(d.getTime() + DAY);
      while (x.getDay() === 0 || x.getDay() === 6) x = new Date(x.getTime() + DAY);
      return x;
    }
    return new Date(d.getTime() + DAY);
  };
  // First skip at least one interval, then keep skipping while still in the
  // past (e.g. the PC was off for a week).
  next = stepForward(next);
  let guard = 0;
  while (next.getTime() <= from.getTime() && guard++ < 500) next = stepForward(next);
  return next.toISOString();
}

/**
 * Parse the many ways a user (or the model) may express a time.
 * Handles "in 45 minutes", "in 2 hours", ISO/"2026-09-27 09:00", "9:30pm",
 * and anything `new Date()` understands. Returns null when unparseable.
 */
export function parseWhen(input: string, now: Date = new Date()): Date | null {
  const s = String(input ?? "").trim();
  if (!s) return null;
  const rel = /^in\s+(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/i.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = /^s/.test(unit) ? n * 1_000 : /^h/.test(unit) ? n * 3_600_000 : n * 60_000;
    return new Date(now.getTime() + ms);
  }
  const clock = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(s);
  if (clock) {
    let h = Number(clock[1]);
    const min = Number(clock[2] ?? 0);
    const ap = (clock[3] ?? "").toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    // Wall-clock digits are in the USER's real zone (Node's ambient zone
    // resolves to UTC on this PC) — build the instant via the explicit offset.
    const localNow = new Date(now.getTime() + tzOffsetMinutes * 60_000);
    let d = new Date(
      Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(), h, min, 0) -
        tzOffsetMinutes * 60_000,
    );
    if (d.getTime() <= now.getTime()) d = new Date(d.getTime() + 86_400_000); // "9am" said at noon = tomorrow
    return d;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})([T ]\d{2}:\d{2}(:\d{2})?)?/.exec(s);
  if (iso) {
    // Naive date-time (no zone): the digits are in the USER's local clock,
    // which on this PC differs from Node's "local" zone — resolve explicitly.
    const d = localWallClockToUtc(s) ?? new Date(s.replace(" ", "T"));
    if (!isNaN(d.getTime())) return d;
  }
  const fallback = new Date(s);
  return isNaN(fallback.getTime()) ? null : fallback;
}

export function formatDue(iso: string): string {
  // Explicit user-local formatting — Node's ambient zone resolves to UTC on
  // this machine, which made every toast show times 5.5h off (IST).
  return formatDueLocal(iso);
}

// ================= store operations =================

export async function listReminders(dataDir: string): Promise<Reminder[]> {
  const store = await readStore(dataDir);
  return store.items
    .filter((r) => !r.done)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

export async function addReminder(
  dataDir: string,
  opts: { text: string; when: Date; repeat?: Repeat }
): Promise<Reminder> {
  const store = await readStore(dataDir);
  const item: Reminder = {
    id: newId(),
    text: opts.text.replace(/\s+/g, " ").trim().slice(0, 300),
    dueAt: opts.when.toISOString(),
    repeat: opts.repeat ?? "none",
    createdAt: new Date().toISOString(),
  };
  store.items = [...store.items.filter((r) => !r.done), item].slice(-MAX_ITEMS);
  await writeStore(dataDir, store);
  return item;
}

/** Cancel by id, or by matching text. Returns the cancelled reminder. */
export async function cancelReminder(dataDir: string, idOrText: string): Promise<Reminder | null> {
  const store = await readStore(dataDir);
  const needle = String(idOrText ?? "").trim().toLowerCase();
  const hit =
    store.items.find((r) => r.id === needle) ??
    store.items.find((r) => r.text.toLowerCase().includes(needle) && needle.length >= 3) ??
    null;
  if (!hit) return null;
  hit.done = true;
  store.items = store.items.filter((r) => r.id !== hit.id);
  await writeStore(dataDir, store);
  return hit;
}

/** Reminders that are due now (and not yet fired). */
export async function dueReminders(dataDir: string, now: Date = new Date()): Promise<Reminder[]> {
  const store = await readStore(dataDir);
  return store.items.filter((r) => !r.done && Date.parse(r.dueAt) <= now.getTime());
}

/**
 * Mark a reminder as fired: record it for the UI feed, then either schedule the
 * next occurrence (repeating) or retire it (one-off).
 */
export async function markFired(dataDir: string, id: string, now: Date = new Date()): Promise<Reminder | null> {
  const store = await readStore(dataDir);
  const item = store.items.find((r) => r.id === id);
  if (!item) return null;
  store.fired.push({ id: item.id, text: item.text, at: now.toISOString() });
  const next = item.repeat === "none" ? null : nextDue(item.dueAt, item.repeat, now);
  item.lastFiredAt = now.toISOString();
  if (!next) {
    item.done = true;
    store.items = store.items.filter((r) => r.id !== item.id);
  } else {
    item.dueAt = next;
  }
  await writeStore(dataDir, store);
  return item;
}

/** Recently fired reminders (for the UI note feed). */
export async function firedReminders(dataDir: string, sinceMs?: number): Promise<FiredReminder[]> {
  const store = await readStore(dataDir);
  const cutoff = sinceMs ?? Date.now() - 24 * 60 * 60 * 1000;
  return store.fired.filter((f) => Date.parse(f.at) >= cutoff);
}
