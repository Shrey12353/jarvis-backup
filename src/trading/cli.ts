import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadFullUniverse, MAX_SHARE_PRICE } from "./universe.js";
import { fetchUniverse, medianTurnover, fetchDailyBars } from "./data.js";
import { strategies, backtest, compareStrategies } from "./strategy.js";
import { runPaperEngine, DEFAULT_RISK } from "./engine.js";
import { positionBudget } from "./risk.js";
import { sma, rsi, closes } from "./indicators.js";

function out(s: string): void {
  console.log(s);
}

/** Build the candidate list: liquid (turnover filter), affordable, EQ-series only. */
async function pickUniverse(opts: { needBars?: boolean; limit?: number } = {}): Promise<string[]> {
  const all = await loadFullUniverse();
  out(`NSE listed universe: ${all.length} EQ-series stocks`);
  // First pass: 3-month daily bars to measure liquidity + last price.
  const sample = await fetchUniverse(
    all.map((s) => s.symbol),
    { period: "3mo", maxConcurrency: 10, onProgress: (d, t, ok, f) => process.stdout.write(`\r  liquidity scan: ${d}/${t} (ok ${ok}, fail ${f})   `) }
  );
  process.stdout.write("\n");
  const liquid: string[] = [];
  for (const [sym, bars] of sample) {
    if (bars.length < 40) continue;
    if (medianTurnover(bars) < 2_500_000) continue; // < Rs25 lakh/day = illiquid, skip
    const px = bars[bars.length - 1].close;
    if (px > MAX_SHARE_PRICE) continue; // can't afford with Rs2,000 budgets
    liquid.push(sym);
  }
  out(`Tradable after filters (liquid + share price <= Rs${MAX_SHARE_PRICE}): ${liquid.length}`);
  return liquid;
}

async function cmdUniverse(): Promise<void> {
  const all = await loadFullUniverse();
  out(`NSE EQ-series universe: ${all.length} stocks (cached in tmp for the day)`);
  const sample = await fetchUniverse(
    all.slice(0, 25).map((s) => s.symbol),
    { period: "3mo", maxConcurrency: 10, onProgress: (d, t) => process.stdout.write(`\r  sample fetch: ${d}/${t}   `) }
  );
  process.stdout.write("\n");
  out(`Sample fetch OK: ${sample.size}/25`);
}

async function cmdScan(): Promise<void> {
  const universe = await pickUniverse();
  out("");
  out("Scanning full universe for today's signals (1y bars)…");
  const data = await fetchUniverse(universe, {
    period: "1y",
    maxConcurrency: 10,
    onProgress: (d, t, ok, f) => process.stdout.write(`\r  ${d}/${t} (ok ${ok}, fail ${f})   `),
  });
  process.stdout.write("\n");
  out(`Fetched: ${data.size}/${universe.length}`);
  const buys: string[] = [];
  const sells: string[] = [];
  const rows: string[] = [];
  for (const [sym, bars] of data) {
    if (bars.length < 210) continue;
    const c = closes(bars);
    const i = bars.length - 1;
    const price = bars[i].close;
    const e50 = sma(c, 50)[i], e200 = sma(c, 200)[i];
    const r2 = rsi(c, 2)[i], s200 = sma(c, 200)[i];
    const sig: string[] = [];
    if (e50 != null && e200 != null) {
      sig.push(e50 > e200 ? "UP" : "DOWN");
      const pe50 = sma(c, 50)[i - 1], pe200 = sma(c, 200)[i - 1];
      if (pe50 != null && pe200 != null) {
        if (pe50 <= pe200 && e50 > pe200) sig.push("GOLDEN-CROSS BUY");
        if (pe50 >= pe200 && e50 < pe200) sig.push("DEATH-CROSS SELL");
      }
    }
    if (s200 != null && r2 != null) {
      if (price > s200 && r2 < 10) sig.push("RSI-REV BUY");
      if (r2 > 65 && price < s200) sig.push("RSI SELL");
    }
    rows.push(`${sym.padEnd(12)} Rs${price.toFixed(1).padStart(8)}  ${sig.join(", ") || "-"}`);
    if (sig.some((x) => x.includes("BUY"))) buys.push(sym);
    if (sig.some((x) => x.includes("SELL"))) sells.push(sym);
  }
  out("");
  out(rows.slice(0, 40).join("\n"));
  if (rows.length > 40) out(`… and ${rows.length - 40} more`);
  out("");
  out(`BUYS today (${buys.length}):  ${buys.slice(0, 15).join(", ")}${buys.length > 15 ? " …" : ""}`);
  out(`SELLS today (${sells.length}): ${sells.slice(0, 15).join(", ")}${sells.length > 15 ? " …" : ""}`);
}

/** Daily scheduled scan: full signals run, saved to a dated report the user can open in Explorer. */
async function cmdDaily(): Promise<void> {
  const reportsDir = path.join(os.homedir(), "jarvis-workspace", "reports");
  await fs.mkdir(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(reportsDir, `signals-${stamp}.txt`);
  const lines: string[] = [];
  const say = (s = ""): void => {
    lines.push(s);
    out(s);
  };
  say("=".repeat(56));
  say(` JARVIS DAILY SIGNALS — ${new Date().toLocaleString("en-IN")}`);
  say("=".repeat(56));
  say("");
  try {
    const universe = await pickUniverse();
    say("");
    say("Scanning full universe for today's signals (1y bars)…");
    const data = await fetchUniverse(universe, { period: "1y", maxConcurrency: 10 });
    const buys: string[] = [];
    const sells: string[] = [];
    const buyRows: string[] = [];
    const sellRows: string[] = [];
    let scanned = 0;
    for (const [sym, bars] of data) {
      if (bars.length < 210) continue;
      scanned++;
      const c = closes(bars);
      const i = bars.length - 1;
      const price = bars[i].close;
      const e50 = sma(c, 50)[i], e200 = sma(c, 200)[i];
      const r2 = rsi(c, 2)[i], s200 = sma(c, 200)[i];
      const sig: string[] = [];
      if (e50 != null && e200 != null) {
        sig.push(e50 > e200 ? "UP" : "DOWN");
        const pe50 = sma(c, 50)[i - 1], pe200 = sma(c, 200)[i - 1];
        if (pe50 != null && pe200 != null) {
          if (pe50 <= pe200 && e50 > pe200) sig.push("GOLDEN-CROSS BUY");
          if (pe50 >= pe200 && e50 < pe200) sig.push("DEATH-CROSS SELL");
        }
      }
      if (s200 != null && r2 != null) {
        if (price > s200 && r2 < 10) sig.push("RSI-REV BUY");
        if (r2 > 65 && price < s200) sig.push("RSI SELL");
      }
      const row = `  ${sym.padEnd(12)} Rs${price.toFixed(1).padStart(8)}  ${sig.join(", ")}`;
      if (sig.some((x) => x.includes("BUY"))) {
        buys.push(sym);
        buyRows.push(row);
      }
      if (sig.some((x) => x.includes("SELL"))) {
        sells.push(sym);
        sellRows.push(row);
      }
    }
    say(`Scanned: ${scanned} stocks`);
    say("");
    say(`BUYS TODAY (${buys.length}):`);
    for (const r of buyRows.length ? buyRows : ["  (none)"]) say(r);
    say("");
    say(`SELLS TODAY (${sells.length}):`);
    for (const r of sellRows.length ? sellRows.slice(0, 60) : ["  (none)"]) say(r);
    if (sellRows.length > 60) say(`  … and ${sellRows.length - 60} more`);
    say("");
    say("Paper signals only — no real orders. Survive/Die governor: max 4 positions x Rs2,000, 5% stop-loss, lock at Rs7,000.");
  } catch (err) {
    say(`ERROR during scan: ${err instanceof Error ? err.message : String(err)}`);
    say("(Data feeds occasionally fail; try again or ask Jarvis to rerun.)");
  }
  // Mail briefing — unread inbox, right under the market signals.
  try {
    const { gmailBriefing } = await import("../tools/gmail.js");
    say("");
    say("=".repeat(56));
    say(" YOUR EMAIL THIS MORNING");
    say("=".repeat(56));
    say(await gmailBriefing());
  } catch (e) {
    say(`(Email brief failed: ${e instanceof Error ? e.message : String(e)})`);
  }
  await fs.writeFile(reportPath, lines.join("\n") + "\n", "utf8");
  out("");
  out(`Report saved: ${reportPath}`);
}

/** Head-to-head: run every strategy on the same universe with one shared data fetch. */
async function cmdCompare(args: string[]): Promise<void> {
  const requested = args.filter((a) => strategies[a]);
  const keys = requested.length ? requested : Object.keys(strategies);
  const unknown = args.filter((a) => !strategies[a]);
  for (const u of unknown) out(`(ignoring unknown strategy: ${u})`);
  const universe = await pickUniverse();
  const capped = universe.slice(0, 300); // one 2y fetch for all strategies
  if (universe.length > capped.length) out(`(comparing on first ${capped.length} of ${universe.length} — alphabetical cap for tractability)`);
  out(`Comparing ${keys.length} strategies on ${capped.length} stocks, 2 years, Rs10,000…\n`);
  const rows = await compareStrategies(keys, capped, 10_000, { period: "2y" });
  const done = rows.filter((r) => r.result);
  done.sort((a, b) => (b.result!.returnPct) - (a.result!.returnPct));
  out("=".repeat(72));
  out(`${"Strategy".padEnd(28)} ${"Return".padStart(8)} ${"Equity".padStart(9)} ${"Trades".padStart(7)} ${"Win%".padStart(6)} ${"MaxDD%".padStart(7)} ${"Hold".padStart(5)}`);
  out("-".repeat(72));
  for (const r of done) {
    const t = r.result!;
    const winRate = t.trades.length ? Math.round((t.wins / t.trades.length) * 100) : 0;
    out(
      `${r.name.padEnd(28)} ${(t.returnPct >= 0 ? "+" : "") + t.returnPct + "%".padEnd(8).slice(0, 7)}` +
      `${String(t.finalEquity).padStart(8)} ${String(t.trades.length).padStart(7)} ${String(winRate).padStart(6)} ${String(t.maxDrawdownPct).padStart(7)} ${String(t.avgHoldDays).padStart(5)}d`
    );
  }
  for (const r of rows) if (!r.result) out(`${r.name.padEnd(28)}  FAILED: ${r.error}`);
  const bh = done.find((r) => r.result!.buyHoldReturnPct != null)?.result!.buyHoldReturnPct;
  if (bh != null) {
    out("-".repeat(72));
    out(`${"(benchmark) Buy & hold".padEnd(28)} ${(bh >= 0 ? "+" : "") + bh + "%"}`);
  }
  out("=".repeat(72));
  if (done.length) {
    const best = done[0];
    out(`Winner: ${best.name} at ${best.result!.returnPct >= 0 ? "+" : ""}${best.result!.returnPct}% — but check MaxDD and trade count before trusting one number.`);
  }
}

async function cmdBacktest(args: string[]): Promise<void> {
  const key = args[0] && strategies[args[0]] ? args[0] : "rsi-reversion";
  const universe = await pickUniverse();
  const capped = universe.slice(0, 300); // keeps the 2y fetch + backtest tractable
  if (universe.length > capped.length) out(`(backtesting first ${capped.length} of ${universe.length} — alphabetical cap for tractability)`);
  out(`Backtesting ${strategies[key].name} on ${capped.length} stocks, 2 years, Rs10,000…`);
  const res = await backtest(key, capped, 10000, { period: "2y", onProgress: (d, t) => process.stdout.write(`\r  fetch: ${d}/${t}   `) });
  process.stdout.write("\n");
  out("");
  out("=".repeat(56));
  out(` RESULT          ${res.returnPct >= 0 ? "+" : ""}${res.returnPct}%  (Rs10,000 -> Rs${res.finalEquity})`);
  out(` Trades          ${res.trades.length} (wins ${res.wins} / losses ${res.losses})`);
  out(` Max drawdown    ${res.maxDrawdownPct}%`);
  out(` Avg hold        ${res.avgHoldDays} days`);
  out("=".repeat(56));
  out("");
  out("Last 8 trades:");
  for (const t of res.trades.slice(-8)) {
    out(`  ${t.entryDate} -> ${t.exitDate}  ${t.symbol.padEnd(12)} ${t.returnPct === null ? "?" : t.returnPct.toFixed(1) + "%"}  Rs${t.pnl === null ? "?" : t.pnl.toFixed(0)}`);
  }
}

async function cmdEngine(args: string[]): Promise<void> {
  const key = args[0] ? args[0] : "rsi-reversion";
  const universe = await pickUniverse();
  const capped = universe.slice(0, 300);
  const budget = positionBudget(DEFAULT_RISK, DEFAULT_RISK.initialCapital);
  out(`Paper engine: ${strategies[key]?.name ?? key}, Rs10,000, Survive/Die governor ON, ${capped.length} stocks`);
  out(`Rules: max ${DEFAULT_RISK.maxPositions} positions x Rs${budget} | stop-loss ${DEFAULT_RISK.stopLossPct}% | day-halt ${DEFAULT_RISK.dailyLossHaltPct}% | LOCK at Rs${Math.round(DEFAULT_RISK.initialCapital * (DEFAULT_RISK.drawdownLockPct / 100))}`);
  out("");
  const res = await runPaperEngine(capped, key, DEFAULT_RISK, { period: "2y" });
  out(`Days: ${res.days}   Final equity: Rs${res.finalEquity} (${res.returnPct >= 0 ? "+" : ""}${res.returnPct}%)   Halted days: ${res.haltedDays}   Stop-outs: ${res.stopOuts}`);
  out("");
  out("Trade log (last 15):");
  for (const line of res.state.tradeLog.slice(-15)) out("  " + line);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "universe") await cmdUniverse();
  else if (cmd === "signals") await cmdScan();
  else if (cmd === "daily") await cmdDaily();
  else if (cmd === "compare") await cmdCompare(rest);
  else if (cmd === "backtest") await cmdBacktest(rest);
  else if (cmd === "engine") await cmdEngine(rest);
  else {
    out("Usage: npm run trade -- <command>");
    out("  universe              how many NSE stocks are listed + data-feed health");
    out("  signals               scan the ENTIRE tradable NSE universe for today's signals");
    out("  daily                 scan + save dated report to jarvis-workspace\\reports (for scheduler)");
    out("  compare [strategies]  head-to-head backtest of all (or listed) strategies, one data fetch");
    out("  backtest [strategy]   2y backtest over the tradable universe (capped at 300 symbols)");
    out("  engine [strategy]     governed paper engine over the tradable universe (capped at 300)");
    out("");
    out(`Strategies: ${Object.keys(strategies).join(", ")}`);
  }
}

void main();
