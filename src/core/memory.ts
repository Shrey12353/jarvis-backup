/**
 * Long-term memory — what Jarvis remembers about YOU between chats.
 *
 * Stored as a plain, human-readable markdown file (data/memory/user.md) so the
 * user can open it, edit a line, delete a line, or back it up. One bullet per
 * fact, newest last. Every chat's system prompt gets this text, so Jarvis stops
 * asking the same questions ("what do you do?" / "which exam?") over and over.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";

export interface MemoryFact {
  /** The fact itself, as plain text. */
  text: string;
  /** YYYY-MM-DD it was saved (empty for hand-written lines). */
  addedAt: string;
}

const MAX_FACTS = 200;
const HEADER = [
  "# Things Jarvis knows about me",
  "<!-- Jarvis adds a line here when you tell him something worth keeping.",
  "     Edit or delete any line by hand — this file is yours. -->",
  "",
].join("\n");

export function memoryFile(dataDir: string): string {
  return path.join(dataDir, "memory", "user.md");
}

/** Parse the memory file: lines like "- [2026-09-26] Fact text". Exported for tests. */
export function parseFacts(raw: string): MemoryFact[] {
  const out: MemoryFact[] = [];
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    const m = /^\s*[-*]\s*(?:\[(\d{4}-\d{2}-\d{2})\]\s*)?(.+?)\s*$/.exec(line);
    if (!m) continue;
    const text = m[2].trim();
    if (!text || /^<!--/.test(text)) continue;
    out.push({ text, addedAt: m[1] ?? "" });
  }
  return out;
}

/** Serialize facts back to the file format. Exported for tests. */
export function renderFacts(facts: MemoryFact[]): string {
  const body = facts.map((f) => `- ${f.addedAt ? `[${f.addedAt}] ` : ""}${f.text}`).join("\n");
  return `${HEADER}${body}${body ? "\n" : ""}`;
}

/** Normalize for duplicate detection: case, punctuation and spacing don't matter. */
export function normalizeFact(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOPWORDS = new Set([
  "i", "my", "me", "myself", "the", "a", "an", "that", "this", "these", "those", "is", "am", "are", "was",
  "were", "be", "been", "in", "on", "at", "of", "to", "and", "or", "for", "with", "it", "its", "as", "do", "does",
]);

/** Significant words of a fact (for fuzzy duplicate detection). */
export function factTokens(text: string): string[] {
  return normalizeFact(text)
    .split(" ")
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * True when `text` is already known: equal, one containing the other, or a
 * high overlap of significant words ("Drinks black coffee in the morning" vs
 * "I drink black coffee in the morning").
 */
function isDuplicate(existing: MemoryFact[], text: string): boolean {
  const n = normalizeFact(text);
  if (!n) return true;
  const toks = factTokens(text);
  return existing.some((f) => {
    const e = normalizeFact(f.text);
    if (e === n) return true;
    if (e.length > 12 && n.length > 12 && (e.includes(n) || n.includes(e))) return true;
    const other = factTokens(f.text);
    if (!toks.length || !other.length) return false;
    const [small, big] = toks.length <= other.length ? [toks, other] : [other, toks];
    const hits = small.filter((w) => big.includes(w)).length;
    return hits / small.length >= 0.7;
  });
}

export async function loadMemoryText(dataDir: string): Promise<string> {
  try {
    return await fsp.readFile(memoryFile(dataDir), "utf8");
  } catch {
    return "";
  }
}

export async function listFacts(dataDir: string): Promise<MemoryFact[]> {
  return parseFacts(await loadMemoryText(dataDir));
}

async function writeFacts(dataDir: string, facts: MemoryFact[]): Promise<void> {
  const file = memoryFile(dataDir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  // Keep the newest MAX_FACTS facts, plus any hand-written lines we can't date.
  const keep = facts.slice(-MAX_FACTS);
  await fsp.writeFile(file, renderFacts(keep), "utf8");
}

/**
 * Save new facts (skipping duplicates and empties). Returns how many were added.
 *
 * New facts are APPENDED (never a full-file rewrite), so a crash, a kill or a
 * power cut can only ever lose the line being written — never the memory the
 * user already has.
 */
export async function addFacts(dataDir: string, texts: string[]): Promise<number> {
  const facts = await listFacts(dataDir);
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  for (const raw of texts) {
    const text = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
    if (text.length < 2 || isDuplicate(facts, text)) continue;
    facts.push({ text, addedAt: today }); // in-memory, so a batch can't duplicate itself
    lines.push(`- [${today}] ${text}`);
  }
  if (!lines.length) return 0;
  const file = memoryFile(dataDir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const existing = await loadMemoryText(dataDir);
  if (!existing.trim()) {
    await fsp.writeFile(file, `${HEADER}${lines.join("\n")}\n`, "utf8");
  } else {
    const sep = existing.endsWith("\n") ? "" : "\n";
    await fsp.appendFile(file, `${sep}${lines.join("\n")}\n`, "utf8");
  }
  return lines.length;
}

/** Remove a fact by its exact text (or a unique part of it). Returns true when something was removed. */
export async function removeFact(dataDir: string, text: string): Promise<boolean> {
  const needle = normalizeFact(text);
  if (!needle) return false;
  const facts = await listFacts(dataDir);
  const exact = facts.filter((f) => normalizeFact(f.text) === needle);
  const matches = exact.length ? exact : facts.filter((f) => normalizeFact(f.text).includes(needle));
  if (!matches.length) return false;
  const keep = facts.filter((f) => !matches.includes(f));
  await writeFacts(dataDir, keep);
  return true;
}

/**
 * Facts the USER explicitly asked to be remembered, taken straight from their
 * message. Small models often answer "noted" without calling the tool, so the
 * server saves these itself — "remember ..." can never silently do nothing.
 * Exported for tests.
 */
export function extractRememberRequests(text: string): string[] {
  const out: string[] = [];
  const re =
    /(?:^|[.!?;\n]|\b(?:and|also|plus|then)\s+)(?:please\s+)?(?:remember|note down|note|keep in mind|save|don'?t forget)(?:\s+that|\s+this)?\s*[:,]?\s*([^.!?;\n]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const tail = m[1].replace(/\s+/g, " ").trim();
    // "remember TO call the CA" is a task (a reminder), not a fact.
    if (/^to\b/i.test(tail)) continue;
    const fact = tail.replace(/^(?:that|this)\s+/i, "").trim();
    // "remember that X and that Y" is two separate facts.
    for (const part of fact.split(/\s+and\s+that\s+|\s+and\s+(?=(?:my|i)\b)|\s*;\s*/i)) {
      const one = part.replace(/^(?:that|this)\s+/i, "").trim();
      if (one.length < 3 || one.length > 300) continue;
      if (/^(me|us|it|this|that|them)$/i.test(one)) continue;
      out.push(one);
    }
  }
  return out.slice(0, 5);
}

/**
 * The memory block appended to Jarvis's system prompt. Empty when there is
 * nothing remembered yet (keeps the prompt token-light for the cloud brain).
 */
export function memoryPromptSection(memoryText: string, maxChars = 4_000): string {
  const facts = parseFacts(memoryText);
  if (!facts.length) return "";
  const lines = facts.map((f) => `- ${f.text}`);
  let body = lines.join("\n");
  if (body.length > maxChars) body = body.slice(body.length - maxChars); // keep the newest
  return [
    "",
    "## What I know about the user (long-term memory)",
    "These facts were learned in earlier chats. Treat them as true unless the user corrects you.",
    "Use them naturally (don't recite the list). Never say you cannot remember across chats — you do.",
    body,
  ].join("\n");
}
