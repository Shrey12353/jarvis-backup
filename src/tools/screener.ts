/**
 * Stock research for Jarvis — reads company fundamentals and screen results
 * from the user's screening platforms (StockScans, Screener.in, ...) through
 * the SHARED SIGNED-IN browser profile.
 *
 * Why the browser and not an API: StockScans is a JavaScript app behind a
 * login, and it has no public data API. Driving a real browser page means
 * whatever the user is signed into simply works — no keys, no scraping hacks —
 * and any Indian screener the user names can be reached by passing its URL.
 */
import { truncate } from "../core/util.js";
import { withAgentProfileTab } from "./browser.js";
import type { Tool, ToolContext } from "./types.js";

/** Shapes pulled out of the live page by evaluate(). Exported for tests. */
export interface PageData {
  title: string;
  url: string;
  h1: string;
  ratios: string[];
  headings: string[];
  tables: string[][][];
  docs: string[];
  body: string;
}

/** Symbol/name → a company page URL; a full URL is passed through untouched. */
export function resolveResearchUrl(args: { company?: unknown; url?: unknown; consolidated?: unknown }): string {
  const direct = String(args.url ?? "").trim();
  if (direct) {
    if (!/^https?:\/\//i.test(direct)) throw new Error(`url must start with http:// or https:// (got "${direct}")`);
    return direct;
  }
  const raw = String(args.company ?? "").trim();
  if (!raw) throw new Error("give `company` (a stock symbol/name) or `url` (a full page address)");
  if (/^https?:\/\//i.test(raw)) return raw;
  // Screener.in addresses companies by symbol and needs no login, so it is the
  // reliable default for "tell me about TCS" when the user has not given a URL.
  const symbol = raw.toUpperCase().replace(/[^A-Z0-9&.-]/g, "");
  if (!symbol) throw new Error(`could not read a stock symbol from "${raw}"`);
  const base = `https://www.screener.in/company/${encodeURIComponent(symbol)}/`;
  return args.consolidated === true ? `${base}consolidated/` : base;
}

function mdTable(rows: string[][], maxRows: number, maxCols: number): string {
  if (!rows.length) return "";
  const cols = Math.min(Math.max(...rows.map((r) => r.length)), maxCols);
  const cell = (v: string) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ");
  const head = rows[0].slice(0, cols);
  // A table whose first row is all numbers is data, not a header — label it.
  const headerLooksLikeData = head.length > 1 && head.every((h) => /^-?[\d.,%]+$/.test(h.trim()));
  const out: string[] = [];
  if (headerLooksLikeData) {
    out.push(`| ${Array.from({ length: cols }, (_, i) => `Column ${i + 1}`).join(" | ")} |`);
    out.push(`| ${head.map(() => "---").join(" | ")} |`);
  } else {
    out.push(`| ${head.map(cell).join(" | ")} |`);
    out.push(`| ${head.map(() => "---").join(" | ")} |`);
  }
  const body = headerLooksLikeData ? rows : rows.slice(1);
  for (const r of body.slice(0, maxRows)) {
    out.push(`| ${Array.from({ length: cols }, (_, i) => cell(r[i] ?? "")).join(" | ")} |`);
  }
  if (body.length > maxRows) out.push(`| … ${body.length - maxRows} more rows |`);
  return out.join("\n");
}

export function formatPageData(d: PageData, maxTables = 4): string {
  const parts: string[] = [`# ${d.h1 || d.title}`, `Source: ${d.url}`];
  if (d.ratios.length) parts.push("", "## Key numbers", ...d.ratios.map((r) => `- ${r}`));
  const tables = d.tables.filter((t) => t.length > 1);
  if (tables.length) {
    parts.push("", `## Financials (${tables.length} tables found)`);
    tables.slice(0, maxTables).forEach((t, i) => {
      parts.push("", `### Table ${i + 1}`, mdTable(t, 30, 12));
    });
  }
  if (d.docs.length) parts.push("", "## Documents / reports", ...d.docs.map((x) => `- ${x}`));
  if (!tables.length && !d.ratios.length) {
    parts.push(
      "",
      "No financial tables were rendered. The page may still be loading or need a sign-in.",
      d.headings.length ? `Headings seen: ${d.headings.join(" | ")}` : "",
      "Visible text:",
      truncate(d.body.replace(/\n{2,}/g, "\n"), 2_500)
    );
  }
  return truncate(parts.filter(Boolean).join("\n"), 14_000);
}

/**
 * Page extraction runs as a STRING, not a function on purpose.
 *
 * The TS bundler injects a __name() helper into compiled functions (to keep
 * their .name). Playwright ships a function's SOURCE to the browser, where
 * __name does not exist — so a function here dies with "__name is not defined"
 * and every lookup silently fails. A string is sent verbatim and is immune.
 */
const EXTRACT_PAGE_JS = `(() => {
  var txt = function (e) { return ((e && e.innerText) || "").replace(/\\s+/g, " ").trim(); };
  var arr = function (x) { return Array.prototype.slice.call(x); };
  var tables = arr(document.querySelectorAll("table")).map(function (t) {
    return arr(t.querySelectorAll("tr")).map(function (tr) { return arr(tr.querySelectorAll("th,td")).map(txt); });
  }).map(function (rows) {
    return rows.filter(function (r) { return r.some(function (c) { return c !== ""; }); });
  }).filter(function (rows) { return rows.length; });
  var ratios = arr(document.querySelectorAll("#top-ratios li, .company-ratios li, [class*='ratio'] li"))
    .map(txt).filter(Boolean).slice(0, 24);
  var docs = arr(document.querySelectorAll("a")).filter(function (a) {
    var t = txt(a);
    return /annual report|investor|filing|transcript|document|presentation|result/i.test(t)
      || /\\.pdf(\\?|$)/i.test(a.getAttribute("href") || "");
  }).map(function (a) { return (txt(a) || "document") + " -> " + (a.getAttribute("href") || ""); })
    .filter(function (s) { return s.length > 6; }).slice(0, 15);
  return {
    title: document.title,
    url: location.href,
    h1: txt(document.querySelector("h1")),
    ratios: ratios,
    headings: arr(document.querySelectorAll("h2,h3")).map(txt).filter(Boolean).slice(0, 20),
    tables: tables,
    docs: docs,
    body: ((document.body && document.body.innerText) || "").slice(0, 4000)
  };
})()`;

export const screenerTools: Tool[] = [
  {
    name: "company_research",
    description:
      "Look up a listed Indian company's fundamentals on the user's stock research platforms (StockScans, Screener.in) using their signed-in browser: key ratios, P&L / balance sheet / quarterly / cash-flow / shareholding tables, and links to annual reports and filings. Also works for a screener RESULTS page (pass its url). Use it for \"tell me about <company>\", \"what are the numbers for X\", \"show me this screen's results\".",
    safety: "auto",
    parameters: {
      type: "object",
      properties: {
        company: { type: "string", description: "Stock symbol or name, e.g. RELIANCE, TCS, HDFC Bank" },
        url: { type: "string", description: "Or a full page address (a StockScans company/screen page, any screener URL)" },
        consolidated: { type: "boolean", description: "Prefer consolidated figures (default standalone)" },
        max_tables: { type: "number", description: "How many financial tables to include (default 4)" },
        wait_ms: { type: "number", description: "Extra wait for JavaScript pages (default 2000)" },
      },
      required: [],
    },
    async run(args, ctx: ToolContext) {
      const url = resolveResearchUrl(args);
      const waitMs = Math.min(Math.max(Number(args.wait_ms ?? 2_000) || 2_000, 0), 20_000);
      // Own tab: a lookup must never navigate away from what the user is doing
      // (e.g. a Google sign-in they are halfway through).
      const { page, close } = await withAgentProfileTab(ctx, url);
      try {
      await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
      if (waitMs) await page.waitForTimeout(waitMs);

      const data = (await page.evaluate(EXTRACT_PAGE_JS)) as PageData;

      const out = formatPageData(data, Math.min(Math.max(Number(args.max_tables ?? 4) || 4, 1), 8));
      return `${out}\n\n(Pulled live from ${data.url} in the signed-in browser.)`;
      } finally {
        await close();
      }
    },
  },
];
