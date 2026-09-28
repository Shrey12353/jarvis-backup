import { fetchUniverse, type Bar } from "./data.js";
import { sma, ema, rsi, atr, closes } from "./indicators.js";

/* ============================== Strategies ============================== */

export interface Strategy {
  name: string;
  /** Evaluate signal for a symbol given its full bar history (index = "today"). */
  signal(bars: Bar[], i: number): Signal;
}

export type Signal = "buy" | "sell" | "hold";

export const strategies: Record<string, Strategy> = {
  /** Golden/death cross: EMA50 vs EMA200 with a trend filter. */
  "trend-cross": {
    name: "Trend Cross (EMA50/EMA200)",
    signal(bars, i) {
      if (i < 210) return "hold";
      const c = closes(bars);
      const e50 = ema(c, 50), e200 = ema(c, 200);
      const fast = e50[i]!, slow = e200[i]!;
      const prevFast = e50[i - 1]!, prevSlow = e200[i - 1]!;
      if (prevFast <= prevSlow && fast > prevSlow) return "buy";
      if (prevFast >= prevSlow && fast < prevSlow) return "sell";
      return "hold";
    },
  },

  /** Mean reversion: RSI(2) extreme with a 200-SMA trend filter. */
  "rsi-reversion": {
    name: "RSI(2) Mean Reversion",
    signal(bars, i) {
      if (i < 210) return "hold";
      const c = closes(bars);
      const r = rsi(c, 2)[i]!;
      const sma200 = sma(c, 200)[i]!;
      const price = bars[i].close;
      if (price > sma200 && r < 10) return "buy";
      if (r > 65) return "sell";
      return "hold";
    },
  },

  /** Breakout: close above 55-day high with volatility filter. */
  breakout: {
    name: "55-day Breakout",
    signal(bars, i) {
      if (i < 210) return "hold";
      const win = bars.slice(i - 55, i);
      const hi = Math.max(...win.map((b) => b.high));
      if (bars[i].close > hi) return "buy";
      const c = closes(bars);
      if (bars[i].close < sma(c, 20)[i]!) return "sell";
      return "hold";
    },
  },

  /** Momentum: 90-day price strength (ROC) while above the 200-SMA trend. */
  momentum: {
    name: "Momentum (90-day ROC)",
    signal(bars, i) {
      if (i < 210) return "hold";
      const c = closes(bars);
      const price = bars[i].close;
      const sma200 = sma(c, 200)[i]!;
      const roc90 = (price / c[i - 90] - 1) * 100; // 90-day rate of change
      const roc20 = (price / c[i - 20] - 1) * 100; // short-term for crash exit
      if (price > sma200 && roc90 > 25) return "buy";
      if (price < sma200 || roc20 < -8) return "sell"; // trend break or momentum crash
      return "hold";
    },
  },

  /** Volume surge: strong up-close on 3x normal volume while above the 200-SMA. */
  "volume-surge": {
    name: "Volume Surge (3x avg)",
    signal(bars, i) {
      if (i < 210) return "hold";
      const b = bars[i];
      const c = closes(bars);
      const avgVol = sma(bars.map((x) => x.volume), 50)[i]!;
      const surge = avgVol > 0 && b.volume >= 3 * avgVol;
      const range = b.high - b.low + 1e-9;
      const strongClose = b.close > b.open && b.high - b.close <= 0.35 * range;
      if (surge && strongClose && b.close > sma(c, 200)[i]!) return "buy";
      if (b.close < sma(c, 20)[i]! || rsi(c, 14)[i]! > 75) return "sell";
      return "hold";
    },
  },
};

/* ============================== Costs & sizing ============================== */

export const COSTS = {
  /** ZeroBrokerage-style: ₹0 delivery equity. Set to your broker's real rate. */
  brokeragePct: 0,
  sttPct: 0.1,           // Securities Transaction Tax on delivery sells
  exchangePct: 0.00325,  // NSE transaction charges approx
  sebiPct: 0.0001,       // SEBI turnover fee
  gstPct: 18,            // GST on brokerage+exchange charges
  stampPct: 0.015,       // stamp duty on buys
  slippagePct: 0.1,      // realistic slippage per side
};

export function roundTripCostPct(): number {
  const b = COSTS;
  const perSide = b.brokeragePct + b.exchangePct + b.sebiPct + b.slippagePct;
  // buy side: exchange+sebi+slippage+stamp; sell side: +STT
  const buy = perSide + b.stampPct;
  const sell = perSide + b.sttPct;
  const taxable = b.brokeragePct + b.exchangePct;
  const gst = (taxable * 2 * b.gstPct) / 100;
  return buy + sell + gst;
}

/* ============================== Backtester ============================== */

export interface Trade {
  symbol: string;
  strategy: string;
  entryDate: string;
  exitDate: string | null;
  entryPx: number;
  exitPx: number | null;
  qty: number;
  pnl: number | null;
  returnPct: number | null;
  reason: string;
}

export interface BacktestResult {
  strategy: string;
  startCapital: number;
  finalEquity: number;
  returnPct: number;
  trades: Trade[];
  wins: number;
  losses: number;
  maxDrawdownPct: number;
  avgHoldDays: number;
  maxConcurrentPositions: number;
  buyHoldReturnPct: number | null;
}

export interface BacktestOpts {
  period?: string;
  riskPerTradePct?: number;
  maxPositions?: number;
  signal?: AbortSignal; // stop button: abandon a long scan
  onProgress?: (done: number, total: number, ok: number, failed: number) => void;
  /** Human-readable stage updates for long runs (shown live in the UI). */
  onStage?: (message: string) => void;
  /** Prefetched bars — lets callers compare many strategies with a single fetch. */
  data?: Map<string, Bar[]>;
}

/** Prices are NSE-style rupee prices; capital in ₹. One position per symbol max. */
export async function backtest(
  strategyKey: string,
  symbols: string[],
  capital: number,
  opts: BacktestOpts = {}
): Promise<BacktestResult> {
  const period = opts.period ?? "2y";
  const riskPct = opts.riskPerTradePct ?? 20; // % of equity deployed per position
  const maxPositions = opts.maxPositions ?? 5;
  const strat = strategies[strategyKey];
  if (!strat) throw new Error(`unknown strategy: ${strategyKey}`);

  const perSideCost = COSTS.slippagePct + COSTS.exchangePct + COSTS.sebiPct; // simplified per-side
  const data = opts.data ?? (await fetchUniverse(symbols, {
    period,
    maxConcurrency: 10,
    signal: opts.signal,
    onProgress: opts.onProgress,
  }));
  if (data.size === 0) throw new Error("no market data available for the requested universe");

  // Build the union timeline of trading dates
  const allDates = new Set<string>();
  for (const bars of data.values()) for (const b of bars) allDates.add(b.date);
  const dates = [...allDates].sort();
  const byDate = new Map<string, Map<string, Bar>>();
  for (const [sym, bars] of data) {
    for (const b of bars) {
      if (!byDate.has(b.date)) byDate.set(b.date, new Map());
      byDate.get(b.date)!.set(sym, b);
    }
  }

  const trades: Trade[] = [];
  const open = new Map<string, Trade>();
  let equity = capital;
  let peak = capital;
  let maxDD = 0;
  let maxConcurrent = 0;
  const equityCurve: number[] = [capital];

  for (let di = 0; di < dates.length; di++) {
    const date = dates[di];

    // 1) Exit pass
    for (const [sym, t] of [...open]) {
      const bars = data.get(sym)!;
      const i = bars.findIndex((b) => b.date === date);
      if (i < 0) continue;
      const sig = strat.signal(bars, i);
      if (sig === "sell") {
        const exitPx = bars[i].close * (1 - perSideCost / 100);
        const pnl = (exitPx - t.entryPx) * t.qty;
        t.exitDate = date;
        t.exitPx = exitPx;
        t.pnl = pnl;
        t.returnPct = (pnl / (t.entryPx * t.qty)) * 100;
        equity += pnl;
        trades.push(t);
        open.delete(sym);
      }
    }

    // 2) Mark-to-market equity
    let mtm = equity;
    for (const [sym, t] of open) {
      const bars = data.get(sym)!;
      const b = bars.find((x) => x.date === date);
      if (b) mtm += (b.close - t.entryPx) * t.qty;
    }
    peak = Math.max(peak, mtm);
    if (peak > 0) maxDD = Math.max(maxDD, ((peak - mtm) / peak) * 100);
    equityCurve.push(mtm);

    // 3) Entry pass
    if (open.size < maxPositions) {
      for (const sym of symbols) {
        if (open.size >= maxPositions) break;
        if (open.has(sym)) continue;
        const bars = data.get(sym);
        if (!bars) continue;
        const i = bars.findIndex((b) => b.date === date);
        if (i < 0) continue;
        if (strat.signal(bars, i) !== "buy") continue;
        const deployable = Math.min(equity * (riskPct / 100), capital * (riskPct / 100));
        const px = bars[i].close * (1 + perSideCost / 100);
        let qty = Math.floor(deployable / px);
        if (qty < 1) continue;
        // position must fit remaining capital headroom
        const cost = px * qty;
        const used = [...open.values()].reduce((a, t) => a + t.entryPx * t.qty, 0);
        if (used + cost > capital * 0.95) {
          qty = Math.floor((capital * 0.95 - used) / px);
          if (qty < 1) continue;
        }
        open.set(sym, {
          symbol: sym,
          strategy: strategyKey,
          entryDate: date,
          exitDate: null,
          entryPx: px,
          exitPx: null,
          qty,
          pnl: null,
          returnPct: null,
          reason: "signal",
        });
      }
    }
    maxConcurrent = Math.max(maxConcurrent, open.size);
  }

  // Force-close anything still open at the last available close
  for (const t of open.values()) {
    const bars = data.get(t.symbol)!;
    const last = bars[bars.length - 1];
    const exitPx = last.close * (1 - perSideCost / 100);
    const pnl = (exitPx - t.entryPx) * t.qty;
    t.exitDate = last.date;
    t.exitPx = exitPx;
    t.pnl = pnl;
    t.returnPct = (pnl / (t.entryPx * t.qty)) * 100;
    equity += pnl;
    trades.push(t);
  }
  open.clear();

  const wins = trades.filter((t) => (t.pnl ?? 0) > 0).length;
  const losses = trades.filter((t) => (t.pnl ?? 0) <= 0).length;
  const avgHold = trades.length
    ? trades.reduce((a, t) => {
        if (!t.exitDate) return a;
        return a + (new Date(t.exitDate).getTime() - new Date(t.entryDate).getTime()) / 86400000;
      }, 0) / trades.length
    : 0;

  // Buy & hold benchmark: equal-weight all symbols from day 1
  let bh: number | null = null;
  {
    let ok = true;
    let total = 0;
    for (const sym of symbols) {
      const bars = data.get(sym);
      if (!bars || bars.length < 2) { ok = false; break; }
      const first = bars[0].close * (1 + perSideCost / 100);
      const last = bars[bars.length - 1].close * (1 - perSideCost / 100);
      total += (last / first - 1) * 100;
    }
    if (ok && symbols.length) bh = total / symbols.length;
  }

  return {
    strategy: strat.name,
    startCapital: capital,
    finalEquity: Math.round(equity),
    returnPct: Math.round(((equity - capital) / capital) * 10000) / 100,
    trades,
    wins,
    losses,
    maxDrawdownPct: Math.round(maxDD * 100) / 100,
    avgHoldDays: Math.round(avgHold),
    maxConcurrentPositions: maxConcurrent,
    buyHoldReturnPct: bh === null ? null : Math.round(bh * 100) / 100,
  };
}

/** Head-to-head result for one strategy in a comparison run. */
export interface CompareRow {
  key: string;
  name: string;
  result: BacktestResult | null;
  error?: string;
}

/**
 * Compare every strategy on the SAME universe, same capital, same rules —
 * with ONE shared data fetch so 5 backtests cost the data of 1.
 */
export async function compareStrategies(
  keys: string[],
  symbols: string[],
  capital: number,
  opts: BacktestOpts = {}
): Promise<CompareRow[]> {
  const data = opts.data ?? (await fetchUniverse(symbols, {
    period: opts.period ?? "2y",
    maxConcurrency: 10,
    signal: opts.signal,
    onProgress: opts.onProgress,
  }));
  const rows: CompareRow[] = [];
  let n = 0;
  for (const key of keys) {
    n++;
    if (!strategies[key]) {
      rows.push({ key, name: key, result: null, error: `unknown strategy: ${key}` });
      continue;
    }
    opts.onStage?.(`testing strategy ${n} of ${keys.length}: ${strategies[key].name}`);
    try {
      const result = await backtest(key, symbols, capital, { ...opts, data });
      rows.push({ key, name: strategies[key].name, result });
    } catch (e) {
      rows.push({ key, name: strategies[key].name, result: null, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return rows;
}
