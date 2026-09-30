/**
 * Model routing for the FreeLLMAPI gateway.
 *
 * The gateway exposes hundreds of models behind one OpenAI-compatible endpoint
 * and resolves the name "auto" to whatever it thinks is free right now. That is
 * fine for availability but not for quality: auto regularly lands on chatty
 * "reasoning" models that leak their thinking and other models that are simply
 * rate-limited or missing a provider key.
 *
 * So instead of one fixed model we keep an ordered preference list PER KIND OF
 * JOB and try them in turn: the strongest tool-caller for agent work, a coder
 * for code, a vision model for images, and so on. The gateway's own "auto" is
 * kept as the final candidate so a request is never left with nothing to try.
 *
 * Everything here is pure — the list of models the gateway actually offers is
 * passed in — so it is cheap to unit-test.
 */

export type TaskKind = "tools" | "code" | "vision" | "general" | "fast";

/**
 * Best-first per job. Left to right = most preferred. Models that are not in
 * the gateway's live list are skipped automatically, so it is safe to name more
 * than the server currently has.
 *
 * `gpt-oss-20b` leads the tool list because it is the one that reliably emits
 * well-formed tool calls with Jarvis's ~59 tool schemas.
 */
const PREFERENCES: Record<TaskKind, string[]> = {
  tools: [
    "gpt-oss-20b",
    "openai/gpt-oss-20b",
    "gpt-oss-120b",
    "qwen3-30b-a3b",
    "gemini-2.5-flash",
    "llama-3.3-70b-instruct",
    "glm-4.7",
    "deepseek-v3.2",
    "mistral-small-3.2-24b",
  ],
  code: [
    "qwen3-coder-30b",
    "qwen3-coder-480b",
    "qwen2.5-coder-32b",
    "qwen2.5-coder-32b-instruct",
    "codestral",
    "deepseek-v3.2",
    "gpt-oss-20b",
    "gemini-2.5-flash",
  ],
  vision: [
    "qwen3-vl-235b-a22b-instruct",
    "qwen3-vl-30b-a3b-instruct",
    "qwen3-vl-235b",
    "gemini-2.5-flash",
    "llama-3.2-11b-vision-instruct",
    "llava-1.5-7b",
  ],
  general: [
    "gemini-2.5-flash",
    "gpt-oss-20b",
    "llama-3.3-70b-instruct",
    "deepseek-v3.2",
    "glm-4.7",
    "qwen3-30b-a3b",
    "mistral-small-3.2-24b",
  ],
  fast: ["llama-3.1-8b-instruct", "llama-3.1-8b", "qwen3-8b", "qwen3-4b-instruct-2507", "mistral-nemo", "gpt-oss-20b"],
};

/** Never let a request end with an empty candidate list. */
export const LAST_RESORT = "auto";

/**
 * Ordered models to try for this job.
 *
 * @param kind        what the model is being asked to do
 * @param available   ids the gateway reports (empty = the list could not be
 *                    fetched, in which case preferences are tried optimistically)
 * @param currentModel the model that last worked; kept first for stickiness so
 *                    a stable session does not hop models on every turn
 * @param limit       how many candidates to try before giving up
 */
export function pickModelOrder(
  kind: TaskKind,
  available: string[],
  currentModel = "",
  limit = 4
): string[] {
  const prefs = PREFERENCES[kind] ?? PREFERENCES.general;
  const known = available.length > 0;
  const has = (m: string) => !known || available.includes(m);
  const out: string[] = [];
  const push = (m: string) => {
    if (m && m !== LAST_RESORT && has(m) && !out.includes(m)) out.push(m);
  };
  // A concrete model that already answered stays first — routing must not make
  // a working session thrash between providers.
  if (currentModel && currentModel !== LAST_RESORT) push(currentModel);
  for (const m of prefs) push(m);
  const top = out.slice(0, Math.max(1, limit - 1));
  // "auto" is the gateway's own routing, so it belongs last as a safety net.
  if (has(LAST_RESORT)) top.push(LAST_RESORT);
  return top.length ? top : [LAST_RESORT];
}

/** Cheap intent guess from the user's latest message (used only as a hint). */
export function taskKindFor(message: string, hasTools: boolean): TaskKind {
  if (hasTools) return "tools";
  const m = message.toLowerCase();
  if (/\b(code|coding|program|script|function|class|method|bug|debug|refactor|compile|error|stack ?trace|typescript|javascript|python|java\b|sql|html|css|regex|api|endpoint|test|npm|git)\b/.test(m)) {
    return "code";
  }
  if (/\b(image|picture|photo|screenshot|diagram|chart|look at|see this)\b/.test(m)) return "vision";
  if (m.length <= 40 && /\b(hi|hello|hey|thanks|ok|what time|date)\b/.test(m)) return "fast";
  return "general";
}
