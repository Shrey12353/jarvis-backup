/**
 * Custom trading strategies — so the user can feed Jarvis new ideas to
 * backtest without anyone editing code.
 *
 * A strategy is a small JSON description of entry/exit RULES built from
 * indicators. It is data, never executable code, so a saved strategy cannot do
 * anything except produce buy/sell/hold signals. Saved under
 * data/strategies/<key>.json and registered into the same `strategies` record
 * the built-ins live in, which means trade_backtest / trade_compare pick them
 * up with no changes at all.
 *
 * Example:
 *   {
 *     "name": "Golden Pocket Pullback",
 *     "entry": [
 *       { "left": "sma(20)", "op": "cross_above", "right": "ema(50)" },
 *       { "left": "price",   "op": ">",           "right": "sma(200)" }
 *     ],
 *     "exit": [ { "left": "rsi(14)", "op": ">", "right": 75 } ]
 *   }
 *
 * Operands: price/close, open, high, low, volume, sma(n), ema(n), rsi(n),
 * atr(n), roc(n) (n-day % change), hhv(n)/llv(n) (highest high / lowest low of
 * the n bars BEFORE today), volavg(n), or a plain number.
 * Operators: > >= < <= cross_above cross_below
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Bar } from "./data.js";
import { atr, closes, ema, rsi, sma } from "./indicators.js";
import { strategies, type Signal, type Strategy } from "./strategy.js";

export const OPERATORS = [">", ">=", "<", "<=", "cross_above", "cross_below"] as const;

const OP_ALIASES: Record<string, string> = {
  above: ">",
  below: "<",
  crosses_above: "cross_above",
  crosses_below: "cross_below",
  crossover: "cross_above",
  crossunder: "cross_below",
};

export const OPERAND_HELP =
  "price/close, open, high, low, volume, sma(n), ema(n), rsi(n), atr(n), roc(n), hhv(n), llv(n), volavg(n), or a number";

export interface StrategyRule {
  left: string | number;
  op: string;
  right: string | number;
}

export interface CustomStrategySpec {
  key?: string;
  name: string;
  description?: string;
  /** Bars a symbol needs before signals are trusted (default 210). */
  minBars?: number;
  entry: StrategyRule[];
  exit?: StrategyRule[];
}

/** Built-in keys captured at load, so a custom strategy can never shadow one. */
export const BUILT_IN_KEYS: string[] = Object.keys(strategies);

const EXPR_RE = /^(sma|ema|rsi|atr|roc|hhv|llv|volavg)\((\d{1,3})\)$/;
const RAW = new Set(["price", "close", "open", "high", "low", "volume"]);

export function normalizeOp(op: unknown): string {
  const raw = String(op ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  const mapped = OP_ALIASES[raw] ?? raw;
  if (!(OPERATORS as readonly string[]).includes(mapped)) {
    throw new Error(`unsupported operator "${op}". Use: ${OPERATORS.join(", ")}`);
  }
  return mapped;
}

/** Check an operand without needing bars — so a bad rule fails at save time. */
export function assertExpr(operand: string | number): void {
  if (typeof operand === "number") return;
  const s = String(operand ?? "").trim().toLowerCase();
  if (!s) throw new Error("empty operand");
  if (/^-?\d+(\.\d+)?$/.test(s)) return;
  if (RAW.has(s)) return;
  if (EXPR_RE.test(s)) return;
  throw new Error(`unknown operand "${operand}". Use: ${OPERAND_HELP}`);
}

// ---------- indicator series (cached per bar array) ----------

const seriesCache = new WeakMap<Bar[], Map<string, Array<number | null>>>();

function computeSeries(bars: Bar[], expr: string): Array<number | null> {
  const c = closes(bars);
  if (expr === "price" || expr === "close") return c;
  if (expr === "open") return bars.map((b) => b.open);
  if (expr === "high") return bars.map((b) => b.high);
  if (expr === "low") return bars.map((b) => b.low);
  if (expr === "volume") return bars.map((b) => b.volume);
  const m = EXPR_RE.exec(expr)!;
  const n = Number(m[2]);
  switch (m[1]) {
    case "sma":
      return sma(c, n);
    case "ema":
      return ema(c, n);
    case "rsi":
      return rsi(c, n);
    case "atr":
      return atr(bars, n);
    case "roc":
      return c.map((v, i) => (i >= n && c[i - n] ? (v / c[i - n]! - 1) * 100 : null));
    case "hhv":
      return bars.map((_b, i) => {
        if (i < n) return null;
        let hi = -Infinity;
        for (let k = i - n; k < i; k++) hi = Math.max(hi, bars[k].high);
        return hi;
      });
    case "llv":
      return bars.map((_b, i) => {
        if (i < n) return null;
        let lo = Infinity;
        for (let k = i - n; k < i; k++) lo = Math.min(lo, bars[k].low);
        return lo;
      });
    case "volavg":
      return sma(bars.map((b) => b.volume), n);
    default:
      throw new Error(`unsupported indicator "${expr}"`);
  }
}

function seriesFor(bars: Bar[], expr: string): Array<number | null> {
  let byExpr = seriesCache.get(bars);
  if (!byExpr) {
    byExpr = new Map();
    seriesCache.set(bars, byExpr);
  }
  let s = byExpr.get(expr);
  if (!s) {
    s = computeSeries(bars, expr);
    byExpr.set(expr, s);
  }
  return s;
}

type Operand = { kind: "num"; value: number } | { kind: "series"; expr: string };
type NormalizedRule = { left: Operand; op: string; right: Operand };

function toOperand(x: string | number): Operand {
  assertExpr(x);
  if (typeof x === "number") return { kind: "num", value: x };
  const s = String(x).trim().toLowerCase();
  if (/^-?\d+(\.\d+)?$/.test(s)) return { kind: "num", value: Number(s) };
  return { kind: "series", expr: s };
}

function valueAt(op: Operand, bars: Bar[], i: number): number | null {
  if (op.kind === "num") return op.value;
  const v = seriesFor(bars, op.expr)[i];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function holds(rule: NormalizedRule, bars: Bar[], i: number): boolean {
  const a = valueAt(rule.left, bars, i);
  const b = valueAt(rule.right, bars, i);
  if (a === null || b === null) return false;
  switch (rule.op) {
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case "cross_above": {
      const pa = valueAt(rule.left, bars, i - 1);
      const pb = valueAt(rule.right, bars, i - 1);
      return pa !== null && pb !== null && pa <= pb && a > b;
    }
    case "cross_below": {
      const pa = valueAt(rule.left, bars, i - 1);
      const pb = valueAt(rule.right, bars, i - 1);
      return pa !== null && pb !== null && pa >= pb && a < b;
    }
    default:
      return false;
  }
}

/** Turn a validated spec into a Strategy the backtester can run. */
export function buildStrategy(spec: CustomStrategySpec): Strategy {
  const entry = (spec.entry ?? []).map(
    (r): NormalizedRule => ({ left: toOperand(r.left), op: normalizeOp(r.op), right: toOperand(r.right) })
  );
  const exitRules = (spec.exit ?? []).map(
    (r): NormalizedRule => ({ left: toOperand(r.left), op: normalizeOp(r.op), right: toOperand(r.right) })
  );
  if (!entry.length) throw new Error("a strategy needs at least one entry rule");
  const minBars = Math.max(2, Math.floor(Number(spec.minBars ?? 210)) || 210);
  return {
    name: spec.name,
    signal(bars: Bar[], i: number): Signal {
      if (i < minBars) return "hold";
      if (entry.every((r) => holds(r, bars, i))) return "buy";
      if (exitRules.length && exitRules.every((r) => holds(r, bars, i))) return "sell";
      return "hold";
    },
  };
}

// ---------- persistence ----------

export function strategyDir(dataDir: string): string {
  return path.join(dataDir, "strategies");
}

export function slugifyKey(text: string): string {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "custom-strategy";
}

export function describeSpec(spec: CustomStrategySpec): string {
  const fmt = (rs: StrategyRule[]) => (rs ?? []).map((r) => `${r.left} ${r.op} ${r.right}`).join(" AND ");
  return `${spec.name} — buy when ${fmt(spec.entry)}${spec.exit?.length ? `; sell when ${fmt(spec.exit)}` : ""}`;
}

/** Read every saved strategy file; unreadable/invalid files are skipped. */
export async function listCustomSpecs(dataDir: string): Promise<CustomSpecWithKey[]> {
  const dir = strategyDir(dataDir);
  let names: string[] = [];
  try {
    names = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: CustomSpecWithKey[] = [];
  for (const f of names) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, f), "utf8")) as CustomStrategySpec;
      out.push({ ...raw, key: raw.key || f.replace(/\.json$/, "") });
    } catch {
      /* skip a broken file rather than failing startup */
    }
  }
  return out;
}

export interface CustomSpecWithKey extends CustomStrategySpec {
  key: string;
}

/** Register everything on disk into the shared strategy record. Returns keys. */
export async function registerCustomStrategies(dataDir: string): Promise<string[]> {
  const specs = await listCustomSpecs(dataDir);
  const loaded: string[] = [];
  for (const spec of specs) {
    try {
      strategies[spec.key] = buildStrategy(spec);
      loaded.push(spec.key);
    } catch {
      /* skip invalid */
    }
  }
  return loaded;
}

export async function addCustomStrategy(
  dataDir: string,
  spec: CustomStrategySpec
): Promise<{ key: string; file: string; name: string }> {
  if (!spec || typeof spec.name !== "string" || !spec.name.trim()) {
    throw new Error("a strategy needs a name");
  }
  const key = slugifyKey(spec.key || spec.name);
  if (BUILT_IN_KEYS.includes(key)) throw new Error(`"${key}" is a built-in strategy — pick another name`);
  // buildStrategy validates every operator and operand, so a bad rule is
  // rejected now rather than silently holding forever during a 6-minute run.
  const strategy = buildStrategy(spec);
  const record: CustomStrategySpec = {
    key,
    name: spec.name.trim(),
    description: spec.description?.trim() || describeSpec(spec),
    minBars: spec.minBars ?? 210,
    entry: spec.entry,
    exit: spec.exit ?? [],
  };
  const dir = strategyDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${key}.json`);
  await fs.writeFile(file, JSON.stringify(record, null, 2), "utf8");
  strategies[key] = strategy;
  return { key, file, name: record.name };
}

export async function removeCustomStrategy(dataDir: string, key: string): Promise<boolean> {
  const k = slugifyKey(key);
  if (BUILT_IN_KEYS.includes(k)) return false;
  let removed = false;
  try {
    await fs.unlink(path.join(strategyDir(dataDir), `${k}.json`));
    removed = true;
  } catch {
    /* not on disk */
  }
  if (strategies[k] && !BUILT_IN_KEYS.includes(k)) {
    delete strategies[k];
    removed = true;
  }
  return removed;
}
