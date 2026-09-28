/**
 * Multi-chat storage for the web UI. Each conversation is its own JSON file
 * under data/sessions/chats/, with an index file (chats.json) powering the
 * sidebar. Zero dependencies, one file per chat so nothing can corrupt
 * anything else.
 */
import { promises as fsp, existsSync } from "node:fs";
import path from "node:path";
import type { OllamaMessage } from "../core/ollama.js";

export interface ChatMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

const SAFE_ID = /^[a-z0-9-]{3,64}$/i;

export function chatsDir(dataDir: string): string {
  return path.join(dataDir, "sessions", "chats");
}

function indexPath(dataDir: string): string {
  return path.join(chatsDir(dataDir), "index.json");
}

function chatFile(dataDir: string, id: string): string {
  return path.join(chatsDir(dataDir), `${id}.json`);
}

/** Titles come from the first user message — short, human, no secrets shown. */
export function deriveTitle(messages: Array<{ role: string; content: string }>): string {
  const first = messages.find((m) => m.role === "user" && m.content.trim());
  if (!first) return "New chat";
  // The message may start with attachment metadata ([Attached pdf: ...]) —
  // the real question is after it. Prefer the "User's question:" section.
  const q = /User's question:\s*([\s\S]+)$/.exec(first.content);
  let text = (q ? q[1] : first.content).trim();
  if (!q) {
    // Strip leading bracketed metadata lines when there's still text after them.
    const stripped = text.replace(/^(\s*\[[^\]]*\]\s*)+/, "").trim();
    if (stripped) text = stripped;
  }
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "New chat";
  return clean.length > 48 ? clean.slice(0, 48) + "…" : clean;
}

export async function ensureChatsDir(dataDir: string): Promise<void> {
  await fsp.mkdir(chatsDir(dataDir), { recursive: true });
}

export async function listChats(dataDir: string): Promise<ChatMeta[]> {
  try {
    const raw = await fsp.readFile(indexPath(dataDir), "utf8");
    const parsed = JSON.parse(raw) as { chats?: ChatMeta[] };
    return (parsed.chats ?? []).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

async function writeIndex(dataDir: string, chats: ChatMeta[]): Promise<void> {
  chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  await fsp.writeFile(indexPath(dataDir), JSON.stringify({ chats }, null, 2), "utf8");
}

export async function createChat(dataDir: string, id?: string): Promise<string> {
  await ensureChatsDir(dataDir);
  const chatId = id && SAFE_ID.test(id) ? id : `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  return chatId;
}

export async function saveChat(
  dataDir: string,
  id: string,
  messages: OllamaMessage[],
  title?: string
): Promise<ChatMeta> {
  if (!SAFE_ID.test(id)) throw new Error(`invalid chat id: ${id}`);
  await ensureChatsDir(dataDir);
  const now = new Date().toISOString();
  const meta: ChatMeta = {
    id,
    title: title?.trim() || deriveTitle(messages),
    createdAt: now,
    updatedAt: now,
    messageCount: messages.filter((m) => m.role === "user" || m.role === "assistant").length,
  };
  await fsp.writeFile(chatFile(dataDir, id), JSON.stringify({ id, savedAt: now, messages }, null, 2), "utf8");
  const chats = await listChats(dataDir);
  const prev = chats.find((c) => c.id === id);
  const merged: ChatMeta = prev
    ? {
        ...meta,
        createdAt: prev.createdAt,
        // Keep the user's title — unless it's still the placeholder from an
        // empty chat, in which case the first real message names it.
        title: prev.title && prev.title !== "New chat" ? prev.title : meta.title,
      }
    : meta;
  const rest = chats.filter((c) => c.id !== id);
  await writeIndex(dataDir, [...rest, merged]);
  return merged;
}

export async function loadChat(dataDir: string, id: string): Promise<OllamaMessage[] | null> {
  if (!SAFE_ID.test(id)) return null;
  try {
    const raw = await fsp.readFile(chatFile(dataDir, id), "utf8");
    const parsed = JSON.parse(raw) as { messages?: OllamaMessage[] };
    return parsed.messages ?? null;
  } catch {
    return null;
  }
}

export async function renameChat(dataDir: string, id: string, title: string): Promise<boolean> {
  const chats = await listChats(dataDir);
  const chat = chats.find((c) => c.id === id);
  if (!chat) return false;
  chat.title = title.trim().slice(0, 80) || chat.title;
  await writeIndex(dataDir, chats);
  return true;
}

export async function deleteChat(dataDir: string, id: string): Promise<boolean> {
  if (!SAFE_ID.test(id)) return false;
  const chats = await listChats(dataDir);
  const chat = chats.find((c) => c.id === id);
  if (!chat) return false;
  await writeIndex(dataDir, chats.filter((c) => c.id !== id));
  await fsp.rm(chatFile(dataDir, id), { force: true });
  return true;
}

/**
 * One-time migration: the old single session.json becomes a real chat so the
 * user's existing history shows up in the sidebar instead of vanishing.
 */
export async function migrateLegacySession(dataDir: string): Promise<void> {
  const legacy = path.join(dataDir, "sessions", "session.json");
  if (!existsSync(legacy)) return;
  try {
    const parsed = JSON.parse(await fsp.readFile(legacy, "utf8")) as { messages?: OllamaMessage[] };
    const msgs = parsed.messages ?? [];
    const convo = msgs.filter((m) => m.role === "user" || m.role === "assistant");
    if (!convo.length) { await fsp.rm(legacy, { force: true }); return; }
    const id = await createChat(dataDir, `migrated-${Date.now().toString(36)}`);
    await saveChat(dataDir, id, msgs, "Older conversation");
    await fsp.rm(legacy, { force: true });
  } catch {
    /* unreadable legacy file — leave it, never break startup over history */
  }
}
