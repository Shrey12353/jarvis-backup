/**
 * Tools for feeding Jarvis new trading strategies to backtest.
 *
 * The user describes an idea in plain language; Jarvis turns it into indicator
 * rules, saves it, and then trade_backtest / trade_compare run it like any
 * built-in strategy. Strategies are pure data (no code), so this is safe to
 * run without an approval card.
 */
import {
  addCustomStrategy,
  describeSpec,
  listCustomSpecs,
  OPERAND_HELP,
  OPERATORS,
  removeCustomStrategy,
  type StrategyRule,
} from "../trading/custom-strategy.js";
import { strategies } from "../trading/strategy.js";
import type { Tool } from "./types.js";

const RULE_SCHEMA = {
  type: "object",
  properties: {
    left: { type: "string", description: `Operand, e.g. "sma(20)", "rsi(2)" or "price"` },
    op: { type: "string", description: OPERATORS.join(" | ") },
    right: { type: "string", description: `Operand or number, e.g. "sma(200)", "price" or 30` },
  },
  required: ["left", "op", "right"],
};

/**
 * Coerce a model-shaped rule into "sma(20)" style.
 * Models invent shapes, so `{indicator:"sma", period:20}` is accepted as well
 * as a plain string or a number.
 */
function exprOf(v: unknown): string | number {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return v;
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const ind = String(o.indicator ?? o.type ?? o.name ?? "").toLowerCase().trim();
    const period = Number(o.period ?? o.n ?? o.length ?? o.window ?? 0);
    if (ind && period) return `${ind}(${period})`;
    if (ind) return ind;
  }
  return String(v);
}

/** "sma(20) cross_above sma(50)" → a rule. */
function parseRuleString(text: string, index: number): StrategyRule {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 3) {
    throw new Error(
      `rule ${index + 1} ("${text}") must read "<operand> <operator> <operand>", e.g. "sma(20) cross_above sma(50)"`
    );
  }
  return { left: parts[0], op: parts[1], right: parts[2] };
}

/**
 * Coerce a model-shaped rule list into typed rules. Accepts the documented
 * {left, op, right} plus the near-miss names models reach for, so a small
 * naming slip does not waste a 6-minute backtest round-trip.
 */
function toRules(v: unknown): StrategyRule[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new Error("rules must be an array of {left, op, right}");
  return v.map((r, idx) => {
    if (typeof r === "string") return parseRuleString(r, idx);
    const o = (r ?? {}) as Record<string, unknown>;
    const left = o.left ?? o.lhs ?? o.a ?? o.x ?? o.indicator1;
    const right = o.right ?? o.rhs ?? o.b ?? o.y ?? o.value ?? o.threshold ?? o.indicator2;
    const op = o.op ?? o.operator ?? o.comparison ?? o.condition;
    if (left === undefined || right === undefined || op === undefined) {
      throw new Error(
        `rule ${idx + 1} needs left, op and right — got ${JSON.stringify(r)}. ` +
          `Expected e.g. {"left":"sma(20)","op":"cross_above","right":"sma(50)"}`
      );
    }
    return { left: exprOf(left), op: String(op), right: exprOf(right) };
  });
}

export const strategyTools: Tool[] = [
  {
    name: "strategy_list",
    description:
      "List every trading strategy available for backtesting: the built-in ones plus any custom strategies the user has added, with the rule that defines each. Use it before backtesting or when the user asks what strategies exist.",
    safety: "auto",
    parameters: { type: "object", properties: {} },
    async run(_args, ctx) {
      const builtIn = new Set(Object.keys(strategies));
      const custom = await listCustomSpecs(ctx.cfg.paths.data);
      const customKeys = new Set(custom.map((c) => c.key));
      const lines: string[] = ["Built-in strategies:"];
      for (const key of builtIn) {
        if (customKeys.has(key)) continue;
        lines.push(`- ${key}: ${strategies[key].name}`);
      }
      lines.push("", `Custom strategies (${custom.length}):`);
      if (!custom.length) lines.push("- none yet — add one with strategy_add");
      for (const c of custom) lines.push(`- ${c.key}: ${describeSpec(c)}`);
      lines.push(
        "",
        "Rule syntax for strategy_add —",
        `  operands: ${OPERAND_HELP}`,
        `  operators: ${OPERATORS.join(", ")}`,
        "  hhv(n)/llv(n) look at the n bars BEFORE today (breakout style).",
        "  A symbol is bought when ALL entry rules are true, sold when ALL exit rules are true."
      );
      return lines.join("\n");
    },
  },
  {
    name: "strategy_add",
    description:
      "Save a new trading strategy as indicator rules so it can be backtested. Turn the user's plain-English idea into entry/exit rules, e.g. 'buy when the 20-day average crosses above the 50-day and price is above the 200-day, sell when RSI is over 75'. After saving, run trade_backtest with the returned key.",
    safety: "auto",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short human name, e.g. \"Golden Pocket Pullback\"" },
        description: { type: "string", description: "One line explaining the idea in plain language" },
        entry: { type: "array", description: "Rules that must ALL be true to buy", items: RULE_SCHEMA },
        exit: { type: "array", description: "Rules that must ALL be true to sell", items: RULE_SCHEMA },
        min_bars: { type: "number", description: "History needed before signals count (default 210)" },
      },
      required: ["name", "entry"],
    },
    async run(args, ctx) {
      const entry = toRules(args.entry);
      if (!entry || !entry.length) throw new Error("`entry` needs at least one rule");
      const res = await addCustomStrategy(ctx.cfg.paths.data, {
        name: String(args.name),
        description: args.description === undefined ? undefined : String(args.description),
        minBars: args.min_bars === undefined ? undefined : Number(args.min_bars),
        entry,
        exit: toRules(args.exit) ?? [],
      });
      return [
        `Saved strategy "${res.name}" as key "${res.key}".`,
        `It is now available to trade_backtest and trade_compare (pass strategy: "${res.key}").`,
        `File: ${res.file.replace(/\\/g, "/").split("/").slice(-3).join("/")}`,
      ].join("\n");
    },
  },
  {
    name: "strategy_remove",
    description: "Delete a custom strategy the user added. Built-in strategies cannot be removed.",
    safety: "ask",
    parameters: {
      type: "object",
      properties: { key: { type: "string", description: "The strategy key to remove" } },
      required: ["key"],
    },
    async run(args, ctx) {
      const key = String(args.key ?? "").trim();
      if (!key) throw new Error("pass the strategy key to remove");
      const ok = await removeCustomStrategy(ctx.cfg.paths.data, key);
      return ok ? `Removed custom strategy "${key}".` : `No custom strategy named "${key}" (built-ins cannot be removed).`;
    },
  },
];
