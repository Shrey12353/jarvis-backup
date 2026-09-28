/**
 * Paper-trading engine — the full daily loop, no real money.
 * Runs strategies under the Survive/Die governor and logs every decision.
 * For real money later: implement a Broker over Angel One SmartAPI / Zerodha
 * Kite Connect and swap it in — the loop stays identical.
 */
import { fetchUniverse, type Bar } from "./data.js";
import { strategies, COSTS } from "./strategy.js";
import {
  DEFAULT_RISK,
  type RiskConfig,
  type HaltLevel,
  canOpen,
  positionBudget,
  checkEquityCircuitBreakers,
  checkDailyLoss,
  hitStopLoss,
} from "./risk.js";

export interface Position {
  symbol: string;
  qty: number;
  entryPx: number;
  entryDate: string;
  stopPx: number;
}

export interface PaperState {
  cash: number;
  positions: Position[];
  equity: number;
  equityStartOfDay: number;
  day: string;
  halt: HaltLevel;
  dayHalted: boolean;
  locked: boolean;
  tradeLog: string[];
}

export function newState(capital: number): PaperState {
  return {
    cash: capital,
    positions: [],
    equity: capital,
    equityStartOfDay: capital,
    day: "",
    halt: "none",
    dayHalted: false,
    locked: false,
    tradeLog: [],
  };
}

const perSideCost = (COSTS.slippagePct + COSTS.exchangePct + COSTS.sebiPct) / 100;

export interface RunResult {
  days: number;
  finalEquity: number;
  returnPct: number;
  state: PaperState;
  haltedDays: number;
  stopOuts: number;
}

/**
 * Day-by-day replay of the exact loop that would run live:
 * stops -> circuit breakers -> exits -> entries (all governed).
 */
export async function runPaperEngine(
  symbols: string[],
  strategyKey: string,
  risk: RiskConfig = DEFAULT_RISK,
  opts: {
    period?: string;
    signal?: AbortSignal;
    onStage?: (message: string) => void;
    onProgress?: (done: number, total: number, ok: number, failed: number) => void;
  } = {}
): Promise<RunResult> {
  const strat = strategies[strategyKey];
  if (!strat) throw new Error(`unknown strategy: ${strategyKey}`);

  const data = await fetchUniverse(symbols, {
    period: opts.period ?? "2y",
    signal: opts.signal,
    onProgress: opts.onProgress,
  });
  const dates = [...new Set([...data.values()].flatMap((b) => b.map((x) => x.date)))].sort();
  const byDate = new Map<string, Map<string, Bar>>();
  for (const [sym, bars] of data) {
    for (const b of bars) {
      if (!byDate.has(b.date)) byDate.set(b.date, new Map());
      byDate.get(b.date)!.set(sym, b);
    }
  }

  const state = newState(risk.initialCapital);
  let haltedDays = 0;
  let stopOuts = 0;

  let dayNo = 0;
  for (const date of dates) {
    dayNo++;
    if (dayNo % 60 === 0) opts.onStage?.(`replaying day ${dayNo} of ${dates.length}`);
    state.day = date;
    state.equityStartOfDay = state.equity;
    state.dayHalted = false;

    // prices today
    const todays = byDate.get(date) ?? new Map<string, Bar>();

    // 1) mark to market: equity = cash + market value of holdings
    let mtm = state.cash;
    for (const p of state.positions) {
      const b = todays.get(p.symbol);
      if (b) mtm += b.close * p.qty;
    }
    state.equity = mtm;

    // 2) circuit breakers
    state.halt = checkEquityCircuitBreakers(risk, state.equity);
    state.locked = state.halt === "locked";
    if (state.locked) {
      state.tradeLog.push(`[${date}] LOCKED: equity ₹${Math.round(state.equity)} below survival floor. Trading stopped permanently.`);
      break;
    }
    if (checkDailyLoss(risk, state.equityStartOfDay, state.equity)) {
      state.dayHalted = true;
      state.tradeLog.push(`[${date}] DAY HALT: loss ≥ ${risk.dailyLossHaltPct}% — no new entries today.`);
      haltedDays++;
    }

    // 3) stop-loss exits (always allowed — protection runs even on halted days)
    for (const p of [...state.positions]) {
      const b = todays.get(p.symbol);
      if (!b) continue;
      const stopHit = hitStopLoss(risk, p.entryPx, b.close) || b.close <= p.stopPx;
      const sellSignal = strat.signal(data.get(p.symbol)!, idxOf(data.get(p.symbol)!, date)) === "sell";
      if (stopHit || sellSignal) {
        const exitPx = b.close * (1 - perSideCost);
        const pnl = (exitPx - p.entryPx) * p.qty;
        state.cash += exitPx * p.qty;
        state.positions = state.positions.filter((x) => x !== p);
        if (stopHit) stopOuts++;
        state.tradeLog.push(
          `[${date}] SELL ${p.symbol} x${p.qty} @ ₹${exitPx.toFixed(2)} (${stopHit ? "STOP-LOSS" : "signal"}) pnl ₹${pnl.toFixed(0)}`
        );
      }
    }

    // 4) new entries (skip if halted/locked)
    if (!state.dayHalted && state.halt === "none") {
      for (const sym of symbols) {
        if (state.positions.length >= risk.maxPositions) break;
        if (state.positions.some((p) => p.symbol === sym)) continue;
        const bars = data.get(sym);
        if (!bars) continue;
        const i = idxOf(bars, date);
        if (i < 0) continue;
        if (strat.signal(bars, i) !== "buy") continue;
        const b = todays.get(sym)!;
        const px = b.close * (1 + perSideCost);
        const decision = canOpen(
          risk,
          { equity: state.equity, cash: state.cash, positions: state.positions.length, halt: state.halt, dayHalted: state.dayHalted },
          px
        );
        if (!decision.allowed) {
          if (state.positions.length === 0 || decision.reasons.some((r) => r.includes("budget")))
            state.tradeLog.push(`[${date}] SKIP ${sym}: ${decision.reasons[0]}`);
          continue;
        }
        const qty = decision.maxQty;
        const atrStop = b.close * (1 - risk.stopLossPct / 100);
        state.cash -= px * qty;
        state.positions.push({ symbol: sym, qty, entryPx: px, entryDate: date, stopPx: atrStop });
        state.tradeLog.push(`[${date}] BUY ${sym} x${qty} @ ₹${px.toFixed(2)} stop ₹${atrStop.toFixed(2)} (budget ₹${decision.positionBudget})`);
      }
    }

    // 5) recompute equity after actions
    let eq = state.cash;
    for (const p of state.positions) {
      const b = todays.get(p.symbol);
      if (b) eq += b.close * p.qty;
    }
    state.equity = eq;
  }

  // final mark-to-market
  const lastDate = dates[dates.length - 1];
  const lastBars = byDate.get(lastDate) ?? new Map<string, Bar>();
  let finalEquity = state.cash;
  for (const p of state.positions) {
    const b = lastBars.get(p.symbol);
    if (b) finalEquity += b.close * p.qty;
  }
  state.equity = finalEquity;

  return {
    days: dates.length,
    finalEquity: Math.round(finalEquity),
    returnPct: Math.round(((finalEquity - risk.initialCapital) / risk.initialCapital) * 10000) / 100,
    state,
    haltedDays,
    stopOuts,
  };
}

function idxOf(bars: Bar[], date: string): number {
  return bars.findIndex((b) => b.date === date);
}

export { positionBudget, DEFAULT_RISK };
export type { RiskConfig, HaltLevel };
