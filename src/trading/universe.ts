/**
 * The entire NSE listed equity universe.
 * Source: NSE's official EQUITY_L.csv (all EQ-series listed companies).
 * Cached on disk for the trading day so repeated runs don't re-download.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

export interface NseStock {
  symbol: string;
  name: string;
}

const CACHE_FILE = path.join(os.tmpdir(), "nse-equity-l.json");
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // half a day

export async function loadFullUniverse(): Promise<NseStock[]> {
  // 1) disk cache
  try {
    const raw = await fs.readFile(CACHE_FILE, "utf8");
    const j = JSON.parse(raw) as { at: number; stocks: NseStock[] };
    if (Date.now() - j.at < CACHE_TTL_MS && j.stocks?.length > 100) return j.stocks;
  } catch {
    /* no cache */
  }

  // 2) download (both NSE archive hosts, UA required)
  const urls = [
    "https://archives.nseindia.com/content/equities/EQUITY_L.csv",
    "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv",
  ];
  let csv: string | null = null;
  let lastErr: unknown = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "accept": "text/csv,*/*",
          "referer": "https://www.nseindia.com/",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      csv = await res.text();
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!csv) throw new Error(`Could not download NSE universe: ${lastErr instanceof Error ? lastErr.message : lastErr}`);

  const stocks = parseEquityLCsv(csv);
  if (stocks.length < 500) throw new Error(`NSE list suspiciously small (${stocks.length}) — refusing to use it`);

  await fs.writeFile(CACHE_FILE, JSON.stringify({ at: Date.now(), stocks }), "utf8").catch(() => {});
  return stocks;
}

export function parseEquityLCsv(csv: string): NseStock[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  const out: NseStock[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const symbol = (cols[0] ?? "").trim();
    const name = (cols[1] ?? "").trim();
    const series = (cols[2] ?? "").trim();
    if (!symbol || series !== "EQ") continue;
    out.push({ symbol, name });
  }
  return out;
}

/** Price ceilings per share so a Rs2,000 budget can actually buy. Used by engine/scan. */
export const MAX_SHARE_PRICE = 1000;
