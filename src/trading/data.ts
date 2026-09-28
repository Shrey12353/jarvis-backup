/** NSE stock data via Yahoo Finance public endpoints — no API key needed. */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

export interface Bar {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const cache = new Map<string, { bars: Bar[]; at: number }>();
const CACHE_MS = 10 * 60 * 1000;

// Disk cache: survives restarts, so the 2nd scan of the day is instant instead
// of re-downloading 1,000+ charts. Daily bars are reused for up to 8 hours;
// a stale copy is still used as an emergency fallback if the feed fails.
const DISK_DIR = path.join(os.homedir(), "jarvis-workspace", "data", "market-cache");
const DISK_FRESH_MS = 8 * 60 * 60 * 1000;

function diskPath(key: string): string {
  return path.join(DISK_DIR, key.replace(/[^A-Za-z0-9_.:-]/g, "_") + ".json");
}

async function diskRead(key: string): Promise<{ at: number; bars: Bar[] } | null> {
  try {
    const j = JSON.parse(await fs.readFile(diskPath(key), "utf8")) as { at?: number; bars: Bar[] };
    if (!Array.isArray(j.bars) || !j.bars.length) return null;
    return { at: j.at ?? 0, bars: j.bars };
  } catch {
    return null;
  }
}

export interface FetchOpts {
  period?: string; // "1y", "2y", ...
  interval?: string; // "1d"
  maxConcurrency?: number; // default 8
  retries?: number; // default 2
  signal?: AbortSignal; // stop button: abandon the rest of the scan
  onProgress?: (done: number, total: number, ok: number, failed: number) => void;
}

/** True when the error is an abort (stop button), not a data failure. */
export function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || /aborted|stop/i.test(e.message));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const e = new Error("aborted by user");
    e.name = "AbortError";
    throw e;
  }
}

async function diskWrite(key: string, bars: Bar[]): Promise<void> {
  try {
    await fs.mkdir(DISK_DIR, { recursive: true });
    await fs.writeFile(diskPath(key), JSON.stringify({ at: Date.now(), bars }), "utf8");
  } catch {
    /* cache is best-effort */
  }
}

export async function fetchDailyBars(symbol: string, opts: FetchOpts = {}): Promise<Bar[]> {
  const period = opts.period ?? "2y";
  const interval = opts.interval ?? "1d";
  const key = `${symbol}:${period}:${interval}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.bars;

  // Fresh on disk (<8h old, e.g. this morning's scan) → no network at all.
  const disk = await diskRead(key);
  if (disk && Date.now() - disk.at < DISK_FRESH_MS) {
    cache.set(key, { bars: disk.bars, at: Date.now() });
    return disk.bars;
  }

  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}.NS` +
    `?range=${period}&interval=${interval}`;
  let lastErr: unknown = null;
  throwIfAborted(opts.signal);
  for (let attempt = 0; attempt <= (opts.retries ?? 2); attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        signal: opts.signal,
      });
      if (res.status === 429) throw new Error("rate limited");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        chart: {
          result?: Array<{
            timestamp?: number[];
            indicators: {
              quote: Array<{
                open?: (number | null)[];
                high?: (number | null)[];
                low?: (number | null)[];
                close?: (number | null)[];
                volume?: (number | null)[];
              }>;
            };
          }>;
          error?: { description?: string } | null;
        };
      };
      const r = json.chart?.result?.[0];
      if (!r?.timestamp?.length) throw new Error("no data");
      const q = r.indicators.quote[0];
      const bars: Bar[] = [];
      for (let i = 0; i < r.timestamp.length; i++) {
        const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
        if (o == null || h == null || l == null || c == null) continue;
        bars.push({
          date: new Date(r.timestamp[i] * 1000).toISOString().slice(0, 10),
          open: o, high: h, low: l, close: c, volume: v ?? 0,
        });
      }
      cache.set(key, { bars, at: Date.now() });
      void diskWrite(key, bars); // save for next time (don't block the scan)
      return bars;
    } catch (e) {
      if (isAbortError(e)) throw e; // stop button — do not retry
      lastErr = e;
      if (attempt < (opts.retries ?? 2)) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      throwIfAborted(opts.signal);
    }
  }
  // Feed failed entirely (offline?) — better a slightly old chart than a crash.
  if (disk) {
    cache.set(key, { bars: disk.bars, at: Date.now() });
    return disk.bars;
  }
  throw new Error(`data feed failed for ${symbol}: ${lastErr instanceof Error ? lastErr.message : lastErr}`);
}

/**
 * Fetch bars for many symbols with bounded concurrency, retries, and progress.
 * Failures are isolated — one dead symbol never kills a scan.
 */
export async function fetchUniverse(symbols: string[], opts: FetchOpts = {}): Promise<Map<string, Bar[]>> {
  const out = new Map<string, Bar[]>();
  const limit = opts.maxConcurrency ?? 8;
  const total = symbols.length;
  let done = 0, ok = 0, failed = 0;
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < symbols.length && !opts.signal?.aborted) {
      const i = idx++;
      try {
        const bars = await fetchDailyBars(symbols[i], opts);
        if (opts.signal?.aborted) return; // stopped mid-symbol — keep what we have
        out.set(symbols[i], bars);
        ok++;
      } catch (e) {
        if (isAbortError(e)) return; // stop button — abandon the rest
        failed++;
      }
      done++;
      // report sparsely so redirected logs aren't flooded
      if (done === total || done % 100 === 0) opts.onProgress?.(done, total, ok, failed);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, total) }, worker));
  return out;
}

/** Median dollar-rupee turnover per day — used to filter illiquid junk. */
export function medianTurnover(bars: Bar[]): number {
  if (!bars.length) return 0;
  const t = bars.slice(-60).map((b) => b.close * b.volume).sort((a, b) => a - b);
  return t[Math.floor(t.length / 2)];
}
