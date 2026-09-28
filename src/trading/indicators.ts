import type { Bar } from "./data.js";

/** Simple moving average. null until n bars are available. */
export function sma(closes: number[], n: number): Array<number | null> {
  const out: Array<number | null> = [];
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= n) sum -= closes[i - n];
    out.push(i >= n - 1 ? sum / n : null);
  }
  return out;
}

/** Exponential moving average. null until n bars are available. */
export function ema(closes: number[], n: number): Array<number | null> {
  const out: Array<number | null> = new Array(closes.length).fill(null);
  if (closes.length < n) return out;
  const k = 2 / (n + 1);
  let e = 0;
  for (let i = 0; i < n; i++) e += closes[i];
  e /= n;
  out[n - 1] = e;
  for (let i = n; i < closes.length; i++) {
    e = e * (1 - k) + closes[i] * k;
    out[i] = e;
  }
  return out;
}

/** Wilder's RSI. null until n bars are available. */
export function rsi(closes: number[], n = 14): Array<number | null> {
  const out: Array<number | null> = new Array(closes.length).fill(null);
  if (closes.length <= n) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= n; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch > 0) avgGain += ch;
    else avgLoss -= ch;
  }
  avgGain /= n;
  avgLoss /= n;
  out[n] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = n + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    avgGain = (avgGain * (n - 1) + Math.max(ch, 0)) / n;
    avgLoss = (avgLoss * (n - 1) + Math.max(-ch, 0)) / n;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** Average True Range (Wilder). null until n bars are available. */
export function atr(bars: Bar[], n = 14): Array<number | null> {
  const out: Array<number | null> = new Array(bars.length).fill(null);
  if (bars.length <= n) return out;
  const tr: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let a = 0;
  for (let i = 1; i <= n; i++) a += tr[i];
  a /= n;
  out[n] = a;
  for (let i = n + 1; i < bars.length; i++) {
    a = (a * (n - 1) + tr[i]) / n;
    out[i] = a;
  }
  return out;
}

export function closes(bars: Bar[]): number[] {
  return bars.map((b) => b.close);
}
