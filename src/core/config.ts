import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";

export type ToolSafety = "auto" | "ask" | "dangerous";

export interface OllamaConfig {
  host: string;
  model: string;
  /** Vision-capable model used when the user attaches images ("" = none). */
  vision_model: string;
  temperature: number;
  num_ctx: number;
}

/**
 * Optional cloud brain for SPEED (OpenAI-compatible: Groq / OpenRouter / ...).
 * Only chat text is sent (with secrets + attachment contents redacted); tools,
 * files, approvals and trading stay on the PC. Empty api_key = fully local.
 */
export interface CloudConfig {
  enabled: boolean;
  base_url: string;
  model: string;
  api_key: string;
}

export interface AgentConfig {
  max_steps: number;
  full_auto: boolean;
  allow_dangerous: boolean;
  workspace: string;
  /**
   * The user's own folders the agent may READ (never write): Downloads,
   * Desktop, Documents... so "summarise the PDF in my Downloads" works.
   * Writes always stay inside the workspace.
   */
  read_roots: string[];
}

export interface VoiceConfig {
  wake_word: string;
  access_key_env: string;
  stt: { command: string; vosk_model: string };
  tts: { engine: "sapi" | "say" | "spd-say" | "none"; rate: number };
  silence_threshold: number;
  max_utterance_ms: number;
}

export interface BrowserConfig {
  headless: boolean;
}

export interface AppConfig {
  ollama: OllamaConfig;
  cloud?: CloudConfig;
  /** Second free provider — takes over when the first hits its per-minute cap. */
  cloud_backup?: CloudConfig;
  agent: AgentConfig;
  voice: VoiceConfig;
  browser: BrowserConfig;
  paths: { data: string };
}

export const DEFAULT_CONFIG: AppConfig = {
  ollama: { host: "http://localhost:11434", model: "qwen2.5-coder:7b", vision_model: "", temperature: 0.2, num_ctx: 8192 },
  cloud: { enabled: true, base_url: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-20b", api_key: "" },
  cloud_backup: { enabled: true, base_url: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-chat-v3-0324:free", api_key: "" },
  agent: {
    max_steps: 25,
    full_auto: false,
    allow_dangerous: false,
    workspace: "",
    read_roots: ["~/Downloads", "~/Desktop", "~/Documents", "~/Pictures"],
  },
  voice: {
    wake_word: "computer",
    access_key_env: "PICOVOICE_ACCESS_KEY",
    stt: { command: "", vosk_model: "" },
    tts: { engine: "sapi", rate: 0 },
    silence_threshold: 450,
    max_utterance_ms: 12000,
  },
  browser: { headless: false },
  paths: { data: "data" },
};

function deepMerge<T>(base: T, override: unknown): T {
  if (override === null || override === undefined) return base;
  if (typeof base !== "object" || Array.isArray(base) || typeof override !== "object" || Array.isArray(override)) {
    return override as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    out[k] = k in out ? deepMerge((base as Record<string, unknown>)[k], v) : v;
  }
  return out as T;
}

/** Load .env from cwd if present (no dependency needed). */
export async function loadDotEnv(dir = process.cwd()): Promise<void> {
  try {
    const text = await fs.readFile(path.join(dir, ".env"), "utf8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    /* no .env — fine */
  }
}

export async function loadConfig(cwd = process.cwd()): Promise<AppConfig> {
  let cfg = structuredClone(DEFAULT_CONFIG);
  const file = path.join(cwd, "config.yaml");
  try {
    const text = await fs.readFile(file, "utf8");
    cfg = deepMerge(cfg, YAML.parse(text));
  } catch (e) {
    // Missing config is fine (defaults used). Parse errors should be visible.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (cfg.agent.workspace) {
    cfg.agent.workspace = cfg.agent.workspace.replace(/^~(?=$|\/|\\)/, os.homedir());
  }
  // When a vision model is configured, persist its name (strip tags like :latest).
  if (process.env.JARVIS_VISION_MODEL) cfg.ollama.vision_model = process.env.JARVIS_VISION_MODEL.replace(/:latest$/, "");
  // Env override for the brain's host (also lets tests point at a dead port).
  if (process.env.JARVIS_OLLAMA_HOST) cfg.ollama.host = process.env.JARVIS_OLLAMA_HOST;
  // Optional cloud brain (fast). Env overrides win over config.yaml; when the
  // key is empty the cloud stays OFF and Jarvis is 100% local.
  if (cfg.cloud) {
    if (process.env.JARVIS_CLOUD_BASE_URL) cfg.cloud.base_url = process.env.JARVIS_CLOUD_BASE_URL;
    if (process.env.JARVIS_CLOUD_MODEL) cfg.cloud.model = process.env.JARVIS_CLOUD_MODEL;
    if (process.env.JARVIS_CLOUD_API_KEY) cfg.cloud.api_key = process.env.JARVIS_CLOUD_API_KEY;
    if (process.env.JARVIS_CLOUD_ENABLED !== undefined) cfg.cloud.enabled = process.env.JARVIS_CLOUD_ENABLED !== "0";
    if (process.env.JARVIS_CLOUD_OFF) cfg.cloud.enabled = false;
  }
  if (cfg.cloud_backup) {
    if (process.env.JARVIS_BACKUP_BASE_URL) cfg.cloud_backup.base_url = process.env.JARVIS_BACKUP_BASE_URL;
    if (process.env.JARVIS_BACKUP_MODEL) cfg.cloud_backup.model = process.env.JARVIS_BACKUP_MODEL;
    if (process.env.JARVIS_BACKUP_API_KEY) cfg.cloud_backup.api_key = process.env.JARVIS_BACKUP_API_KEY;
    if (process.env.JARVIS_OPENROUTER_API_KEY) cfg.cloud_backup.api_key = process.env.JARVIS_OPENROUTER_API_KEY;
    if (process.env.JARVIS_BACKUP_OFF) cfg.cloud_backup.enabled = false;
  }
  // Env override for the vision model used for image attachments.
  if (process.env.JARVIS_VISION_MODEL !== undefined) cfg.ollama.vision_model = process.env.JARVIS_VISION_MODEL;
  // Env override: scheduled runs force the browser headless (no windows popping up).
  if (process.env.JARVIS_BROWSER_HEADLESS !== undefined) cfg.browser.headless = process.env.JARVIS_BROWSER_HEADLESS !== "0";
  return cfg;
}

/** Expand a leading ~ to the user's home directory. */
export function expandHome(p: string): string {
  return String(p ?? "").trim().replace(/^~(?=$|\/|\\)/, os.homedir());
}

/**
 * The extra folders the agent may READ (already absolute, duplicates removed).
 * These are read-only: writes are still confined to the workspace.
 */
export function resolveReadRoots(cfg: AppConfig): string[] {
  const out: string[] = [];
  for (const raw of cfg.agent.read_roots ?? []) {
    const abs = expandHome(String(raw ?? ""));
    if (!abs) continue;
    const full = path.resolve(abs);
    if (!out.includes(full)) out.push(full);
  }
  return out;
}

/** True when `abs` is the root itself or lives inside it (case-insensitive on Windows). */
export function isInsideRoot(abs: string, root: string): boolean {
  const norm = (s: string): string => (process.platform === "win32" ? path.resolve(s).toLowerCase() : path.resolve(s));
  const a = norm(abs), r = norm(root);
  return a === r || a.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/**
 * Resolve a path the agent wants to READ: allowed inside the workspace or
 * inside one of the user's read-only folders. Returns null when it escapes.
 */
export function resolveReadablePath(p: string, workspace: string, readRoots: string[]): string | null {
  if (!p || !String(p).trim()) return null;
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(workspace, p);
  if (isInsideRoot(abs, workspace)) return abs;
  for (const root of readRoots) if (isInsideRoot(abs, root)) return abs;
  return null;
}

/**
 * Effective workspace root for this session.
 * Priority: agent.workspace (config) -> JARVIS_WORKSPACE env -> ~/jarvis-workspace.
 * The default is deliberately OUTSIDE the agent's own install directory so a
 * confused model can never clobber this codebase by writing to ".".
 */
export function resolveWorkspaceCfg(cfg: AppConfig): string {
  const raw = cfg.agent.workspace || process.env.JARVIS_WORKSPACE || "";
  const expanded = raw.replace(/^~(?=$|\/|\\)/, os.homedir());
  return path.resolve(expanded || path.join(os.homedir(), "jarvis-workspace"));
}

/**
 * Resolve `p` against `root` and refuse anything that escapes the workspace
 * ("../", absolute paths on other trees, drive changes on Windows).
 * Returns the absolute confined path, or null when it escapes.
 */
export function confineToWorkspace(p: string, root: string): string | null {
  if (!p || !p.trim()) return null;
  const abs = path.resolve(root, p);
  const normRoot = path.resolve(root);
  const rel = path.relative(normRoot, abs);
  if (rel === "" || rel === ".") return abs; // the workspace root itself
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return abs;
}
