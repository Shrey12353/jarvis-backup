import type { Tool } from "./types.js";
import { loadFullUniverse } from "../trading/universe.js";
import { fetchUniverse, medianTurnover, fetchDailyBars } from "../trading/data.js";
import { strategies, backtest, compareStrategies } from "../trading/strategy.js";
import { runPaperEngine, DEFAULT_RISK } from "../trading/engine.js";
import { positionBudget } from "../trading/risk.js";
import { sma, rsi, closes } from "../trading/indicators.js";
import { MAX_SHARE_PRICE } from "../trading/universe.js";

const out: string[] = [];
function emit(s = ""): void {
  out.push(s);
}
function flush(): string {
  const s = out.join("\n");
  out.length = 0;
  return s;
}

/** Shared: full NSE list -> liquidity + price filters -> tradable list. */
async function tradableUniverse(
  signal?: AbortSignal,
  progress?: (message: string) => void
): Promise<{ list: string[]; total: number; failedFetches: number }> {
  const all = await loadFullUniverse();
  progress?.(`checking ${all.length} listed NSE stocks for liquidity…`);
  const sample = await fetchUniverse(all.map((s) => s.symbol), {
    period: "3mo",
    maxConcurrency: 10,
    signal,
    onProgress: (done, total, _ok, failed) =>
      progress?.(`lifting prices: ${done} of ${total}${failed ? ` (${failed} unavailable)` : ""}`),
  });
  let failedFetches = 0;
  const list: string[] = [];
  for (const [sym, bars] of sample) {
    if (bars.length < 40) {
      failedFetches++;
      continue;
    }
    if (medianTurnover(bars) < 2_500_000) continue; // illiquid — skip
    if (bars[bars.length - 1].close > MAX_SHARE_PRICE) continue; // unaffordable
    list.push(sym);
  }
  return { list, total: all.length, failedFetches };
}

export const tradingTools: Tool[] = [
  {
    name: "trade_universe",
    description:
      "Health check of the Indian trading system: how many NSE stocks are listed, how many pass liquidity/price filters. Call before explaining the trading setup to the user.",
    safety: "auto",
    parameters: { type: "object", properties: {} },
    async run(_args, ctx) {
      const all = await loadFullUniverse();
      const { list, total, failedFetches } = await tradableUniverse(ctx.signal, ctx.progress);
      emit(`NSE listed universe: ${total} EQ-series stocks`);
      emit(`Tradable after filters (liquid + share price <= Rs${MAX_SHARE_PRICE}): ${list.length}`);
      emit(`Data feed failures: ${failedFetches}`);
      return flush();
    },
  },

  {
    name: "trade_signals",
    description:
      "Scan the ENTIRE tradable NSE universe (~1200 stocks) for today's BUY/SELL signals using the active strategies (trend-cross, RSI(2) mean reversion, breakout, momentum, volume-surge). Takes ~3-5 minutes. Returns buy list, sell list, and notable stocks with prices.",
    safety: "auto",
    parameters: { type: "object", properties: {} },
    async run(_args, ctx) {
      const { list } = await tradableUniverse(ctx.signal, ctx.progress);
      emit(`Scanning ${list.length} tradable NSE stocks…`);
      ctx.progress?.(`fetching a year of prices for ${list.length} stocks…`);
      const data = await fetchUniverse(list, {
        period: "1y",
        maxConcurrency: 10,
        signal: ctx.signal,
        onProgress: (done, total, _ok, failed) =>
          ctx.progress?.(`fetching prices: ${done} of ${total}${failed ? ` (${failed} unavailable)` : ""}`),
      });
      let buys: Array<{ sym: string; px: number }> = [];
      let sells: Array<{ sym: string; px: number }> = [];
      let scanned = 0;
      for (const [sym, bars] of data) {
        if (bars.length < 210) continue;
        scanned++;
        if (scanned % 200 === 0) ctx.progress?.(`checking today's signals: ${scanned} of ${data.size} stocks`);
        const c = closes(bars);
        const i = bars.length - 1;
        const px = bars[i].close;
        const e50 = sma(c, 50)[i], e200 = sma(c, 200)[i];
        const r2 = rsi(c, 2)[i], s200 = sma(c, 200)[i];
        let isBuy = false, isSell = false;
        if (e50 != null && e200 != null) {
          const pe50 = sma(c, 50)[i - 1], pe200 = sma(c, 200)[i - 1];
          if (pe50 != null && pe200 != null) {
            if (pe50 <= pe200 && e50 > pe200) isBuy = true;
            if (pe50 >= pe200 && e50 < pe200) isSell = true;
          }
        }
        if (s200 != null && r2 != null) {
          if (px > s200 && r2 < 10) isBuy = true;
          if (r2 > 65 && px < s200) isSell = true;
        }
        if (isBuy) buys.push({ sym, px });
        if (isSell) sells.push({ sym, px });
      }
      emit(`Scanned: ${scanned} stocks`);
      emit(`BUYS today (${buys.length}): ${buys.slice(0, 20).map((b) => `${b.sym}(Rs${b.px.toFixed(0)})`).join(", ")}`);
      emit(`SELLS today (${sells.length}): ${sells.slice(0, 20).map((s) => `${s.sym}(Rs${s.px.toFixed(0)})`).join(", ")}`);
      return flush();
    },
  },

  {
    name: "trade_compare",
    description:
      "Head-to-head backtest of ALL strategies (trend-cross, rsi-reversion, breakout, momentum, volume-surge) on the same universe, same Rs10,000 capital, one shared data fetch. Takes ~5-8 minutes. Use when the user asks which strategy is best or to compare strategies.",
    safety: "auto",
    parameters: { type: "object", properties: {} },
    async run(_args, ctx) {
      const { list } = await tradableUniverse(ctx.signal, ctx.progress);
      const capped = list.slice(0, 300);
      ctx.progress?.(`comparing 5 strategies on ${capped.length} stocks (2 years each)…`);
      const rows = await compareStrategies(Object.keys(strategies), capped, 10_000, {
        period: "2y",
        signal: ctx.signal,
        onStage: ctx.progress,
        onProgress: (done, total) => ctx.progress?.(`fetching prices: ${done} of ${total}`),
      });
      const done = rows.filter((r) => r.result).sort((a, b) => b.result!.returnPct - a.result!.returnPct);
      emit(`Compared ${done.length} strategies on ${capped.length} stocks, 2 years, Rs10,000 (ranked):`);
      for (const r of done) {
        const t = r.result!;
        const wr = t.trades.length ? Math.round((t.wins / t.trades.length) * 100) : 0;
        emit(`  ${r.name}: ${t.returnPct >= 0 ? "+" : ""}${t.returnPct}% (Rs${t.finalEquity}), ${t.trades.length} trades, win ${wr}%, maxDD ${t.maxDrawdownPct}%, avg hold ${t.avgHoldDays}d`);
      }
      for (const r of rows) if (!r.result) emit(`  ${r.name}: FAILED (${r.error})`);
      const bh = done.find((r) => r.result!.buyHoldReturnPct != null)?.result!.buyHoldReturnPct;
      if (bh != null) emit(`  Buy & hold benchmark: ${bh >= 0 ? "+" : ""}${bh}%`);
      if (done.length) emit(`Best: ${done[0].name} — weigh return against maxDD and trade count before choosing.`);
      return flush();
    },
  },

  {
    name: "trade_backtest",
    description:
      "Backtest a trading strategy over the tradable NSE universe with realistic Indian costs (STT, GST, stamp duty, slippage), Rs10,000 start, 2 years. Strategies: rsi-reversion (default), trend-cross, breakout. Takes ~5-8 minutes.",
    safety: "auto",
    parameters: {
      type: "object",
      properties: {
        strategy: { type: "string", description: "rsi-reversion | trend-cross | breakout | momentum | volume-surge (default rsi-reversion)" },
      },
    },
    async run(args, ctx) {
      const key = args.strategy && strategies[String(args.strategy)] ? String(args.strategy) : "rsi-reversion";
      const { list } = await tradableUniverse(ctx.signal, ctx.progress);
      const capped = list.slice(0, 300);
      ctx.progress?.(`backtesting ${strategies[key].name} on ${capped.length} stocks…`);
      const res = await backtest(key, capped, 10_000, {
        period: "2y",
        signal: ctx.signal,
        onProgress: (done, total) => ctx.progress?.(`fetching prices: ${done} of ${total}`),
      });
      emit(`Backtest: ${strategies[key].name}, ${capped.length} stocks, 2 years, Rs10,000 start`);
      emit(`RESULT: ${res.returnPct >= 0 ? "+" : ""}${res.returnPct}% (Rs10,000 -> Rs${res.finalEquity})`);
      emit(`Trades: ${res.trades.length} (wins ${res.wins} / losses ${res.losses})`);
      emit(`Max drawdown: ${res.maxDrawdownPct}% | Avg hold: ${res.avgHoldDays} days`);
      emit("Last 5 trades:");
      for (const t of res.trades.slice(-5)) {
        emit(`  ${t.entryDate} -> ${t.exitDate} ${t.symbol} ${t.returnPct === null ? "?" : t.returnPct.toFixed(1) + "%"} Rs${t.pnl === null ? "?" : t.pnl.toFixed(0)}`);
      }
      return flush();
    },
  },

  {
    name: "trade_engine",
    description:
      "Run the paper-trading engine under the Survive/Die governor: Rs10,000, max 4 positions x Rs2,000, 5% stop-loss, day-halt at -2%, hard lock at Rs7,000 equity. Simulates the exact live loop over 2 years of data. Takes ~5-8 minutes.",
    safety: "auto",
    parameters: {
      type: "object",
      properties: {
        strategy: { type: "string", description: "rsi-reversion | trend-cross | breakout | momentum | volume-surge (default rsi-reversion)" },
      },
    },
    async run(args, ctx) {
      const key = args.strategy && strategies[String(args.strategy)] ? String(args.strategy) : "rsi-reversion";
      const { list } = await tradableUniverse(ctx.signal, ctx.progress);
      const capped = list.slice(0, 300);
      ctx.progress?.(`running the paper engine on ${capped.length} stocks…`);
      const res = await runPaperEngine(capped, key, DEFAULT_RISK, {
        period: "2y",
        signal: ctx.signal,
        onStage: ctx.progress,
        onProgress: (done, total) => ctx.progress?.(`fetching prices: ${done} of ${total}`),
      });
      emit(`Paper engine: ${strategies[key].name}, Rs10,000, Survive/Die ON, ${capped.length} stocks`);
      emit(`Days: ${res.days} | Final equity: Rs${res.finalEquity} (${res.returnPct >= 0 ? "+" : ""}${res.returnPct}%) | Halted days: ${res.haltedDays} | Stop-outs: ${res.stopOuts}`);
      emit("Trade log (last 10):");
      for (const line of res.state.tradeLog.slice(-10)) emit("  " + line);
      emit("PAPER ONLY — real orders need a broker API (Angel One SmartAPI / Zerodha Kite Connect).");
      return flush();
    },
  },
];
