/**
 * CHARLIE — Jarvis's product-ideas sub-agent. Now connected to the live web.
 *
 * His only job: find trending product ideas that could sell on e-commerce
 * platforms. Before every answer he SEARCHES the web and READS real pages
 * (Google Trends India, Indian business/deal sites), then thinks with the
 * same local model as Jarvis — nothing leaves the PC except his web requests.
 *
 * He reports to Jarvis (who reports to you). If the web is unreachable he
 * says so plainly and falls back to memory-based ideas, clearly labeled.
 *
 * Run:  node charlie/charlie.mjs [your question]   (default: fresh 5 ideas)
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---- load model config from Jarvis's config.yaml (single source of truth) ----
function modelFromConfig() {
  try {
    const cfgPath = path.join(HERE, "..", "config.yaml");
    if (existsSync(cfgPath)) {
      const txt = readFileSync(cfgPath, "utf8");
      const m = /^\s*model:\s*(\S+)/m.exec(txt);
      if (m) return m[1];
    }
  } catch { /* fall through */ }
  return "qwen2.5:3b";
}

const MODEL = modelFromConfig();
const OLLAMA = process.env.OLLAMA_HOST || "http://localhost:11434";

// ---- optional fast cloud brain (the same free key Jarvis uses) ----
// Charlie used to think only on the local 3B model (tens of seconds). When a
// cloud key is configured he thinks in the cloud and falls back to the local
// model on any error — same guarantee as Jarvis: never a charge, never a crash.
function envValue(key) {
  try {
    const txt = readFileSync(path.join(HERE, "..", ".env"), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      if (line.trim().startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      if (line.slice(0, eq).trim() !== key) continue;
      return line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* no .env — fine */ }
  return process.env[key] || "";
}

const CLOUD_KEY = envValue("JARVIS_CLOUD_API_KEY");
const CLOUD_BASE = (envValue("JARVIS_CLOUD_BASE_URL") || "https://api.groq.com/openai/v1").replace(/\/$/, "");
const CLOUD_MODEL = envValue("JARVIS_CLOUD_MODEL");
const CLOUD_MAX_RESEARCH_CHARS = 12_000; // stay inside free per-minute token caps

async function cloudThink(systemPrompt, userPrompt) {
  if (!CLOUD_KEY || !CLOUD_MODEL || process.env.CHARLIE_LOCAL_ONLY) return null;
  try {
    const res = await fetchWithTimeout(`${CLOUD_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${CLOUD_KEY}` },
      body: JSON.stringify({
        model: CLOUD_MODEL,
        stream: false,
        temperature: 0.8,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt.slice(0, CLOUD_MAX_RESEARCH_CHARS) },
        ],
      }),
    }, 60_000);
    if (!res.ok) return null;
    const j = await res.json();
    return (j.choices?.[0]?.message?.content || "").trim() || null;
  } catch {
    return null;
  }
}
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Charlie-Agent/0.1";
const FETCH_TIMEOUT_MS = 15_000;
const MAX_PAGES = 6;

/** Pages Charlie always checks, plus whatever his searches turn up. */
const START_SOURCES = [
  "https://trends.google.com/trending?geo=IN",
  "https://www.indiafreestuff.in",
];

// ================= web research =================

/** fetch with a hard timeout so one slow site can't stall Charlie. */
function fetchWithTimeout(url, opts = {}, ms = FETCH_TIMEOUT_MS) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
}

function stripTags(s) {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse DuckDuckGo HTML results (same source Jarvis's web_search uses). */
export function extractDuckResults(html, limit = 8) {
  const results = [];
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets = [];
  let m;
  while ((m = snipRe.exec(html)) && snippets.length < 10) snippets.push(stripTags(m[1]));
  let i = 0;
  while ((m = linkRe.exec(html)) && results.length < limit) {
    let href = m[1];
    // DDG wraps URLs: //duckduckgo.com/l/?uddg=<encoded>&rut=...
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) href = decodeURIComponent(uddg[1]);
    if (href.startsWith("//")) href = "https:" + href;
    if (href.includes("duckduckgo.com/y.js")) continue; // ads
    results.push({ title: stripTags(m[2]), url: href, snippet: snippets[i] ?? "" });
    i++;
  }
  return results;
}

/** Turn messy HTML into plain readable text (drops scripts/styles/tags). */
export function extractPageText(html, maxLen = 4_000) {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return stripTags(body).slice(0, maxLen);
}

async function searchWeb(query) {
  const res = await fetchWithTimeout("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
    body: new URLSearchParams({ q: query }).toString(),
  });
  if (!res.ok) throw new Error(`search failed: HTTP ${res.status}`);
  return extractDuckResults(await res.text());
}

async function readPage(url) {
  const res = await fetchWithTimeout(url, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("text/html") && !ct.includes("text/plain")) throw new Error(`not a text page (${ct.split(";")[0]})`);
  return extractPageText(await res.text());
}

/** Search + read across sources. Never throws: returns what it got plus errors. */
export async function researchWeb(queries) {
  const urls = new Set(START_SOURCES);
  const errors = [];
  for (const q of queries) {
    try {
      for (const r of await searchWeb(q)) urls.add(r.url);
    } catch (e) {
      errors.push(`search "${q}": ${e.message}`);
    }
  }
  const evidence = [];
  for (const url of [...urls].slice(0, MAX_PAGES)) {
    try {
      evidence.push({ url, text: await readPage(url) });
    } catch (e) {
      errors.push(`${url}: ${e.message}`);
    }
  }
  return { evidence, errors };
}

// ================= thinking =================

// ---- Charlie's personality (what makes him Charlie and not Jarvis) ----
const CHARLIE_PROMPT = `You are Charlie, a sharp e-commerce product-trend scout.
Your ONLY job: find trending product ideas that could sell on online marketplaces.
Before answering you always look at LIVE WEB RESEARCH your harness fetched for you.
Rules for every answer:
- Exactly 5 ideas, numbered 1-5.
- Each idea: product name (bold), one line why it's trending NOW (tie it to the research when you can), typical selling price in INR, and a difficulty tag (easy/medium/hard) for a beginner seller.
- Be concrete (real product categories, not "a gadget").
- Ground your ideas in the research provided — do not invent what the sources say.
- End with a "Sources:" line listing 1-3 of the URLs you actually used.
- No preamble, no sign-off.`;

function buildResearchBlock(evidence) {
  return evidence
    .map((e, i) => `[Source ${i + 1}] ${e.url}\n${e.text}`)
    .join("\n\n");
}

async function charlieThink(question, evidence) {
  const user = `LIVE WEB RESEARCH (fetched just now, ${evidence.length} pages):\n\n${buildResearchBlock(evidence)}\n\nQuestion: ${question}`;
  const fromCloud = await cloudThink(CHARLIE_PROMPT, user);
  if (fromCloud) return fromCloud;
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      messages: [
        { role: "system", content: CHARLIE_PROMPT },
        { role: "user", content: user },
      ],
      options: { temperature: 0.8 },
    }),
  });
  if (!res.ok) throw new Error(`Ollama said ${res.status}`);
  const data = await res.json();
  return (data.message?.content || "").trim();
}

/** Honest fallback: brain works, web doesn't. Clearly labeled, never faked. */
async function charlieFromMemory(question, errors) {
  const notice = `WARNING: live web research failed (${errors.slice(0, 3).join("; ")}). These ideas come from your training memory, NOT today's data — say so in one short line at the top.`;
  const fromCloud = await cloudThink(CHARLIE_PROMPT, `${notice}\n\nQuestion: ${question}`);
  if (fromCloud) return fromCloud;
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      messages: [
        { role: "system", content: CHARLIE_PROMPT },
        { role: "user", content: `${notice}\n\nQuestion: ${question}` },
      ],
      options: { temperature: 0.8 },
    }),
  });
  if (!res.ok) throw new Error(`Ollama said ${res.status}`);
  const data = await res.json();
  return (data.message?.content || "").trim();
}

// ================= image search =================

/**
 * DuckDuckGo image search without an API key:
 *  1. GET duckduckgo.com/?q=... to scrape the per-session vqd token
 *  2. GET /i.js?l=us-en&o=json&q=...&vqd=... → JSON with image results
 * Only the fields we need are kept. Pure string handling is exported for tests.
 */
export function parseDuckImages(jsonBody, limit = 6) {
  let j;
  try { j = JSON.parse(jsonBody); } catch { return []; }
  const rows = Array.isArray(j?.results) ? j.results : [];
  const out = [];
  for (const r of rows) {
    const url = typeof r?.image === "string" ? r.image : "";
    if (!/^https?:\/\//i.test(url)) continue;
    if (!/\.(jpe?g|png|webp)(\?|$)/i.test(url)) continue; // what <img> can render
    out.push({ image: url, width: Number(r.width) || 0, height: Number(r.height) || 0,
      source: typeof r?.url === "string" ? r.url : "" });
    if (out.length >= limit) break;
  }
  return out;
}

export function parseVqd(html) {
  const m = /vqd="([\d-]+)"/.exec(html) || /vqd=([\w-]+)&/.exec(html);
  return m ? m[1] : null;
}

async function imageSearch(query, limit = 6) {
  const home = await fetchWithTimeout(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`,
    { headers: { "user-agent": UA } });
  if (!home.ok) throw new Error(`image search failed: HTTP ${home.status}`);
  const vqd = parseVqd(await home.text());
  if (!vqd) throw new Error("image search: no vqd token");
  const api = await fetchWithTimeout(
    `https://duckduckgo.com/i.js?l=wt-wt&o=json&q=${encodeURIComponent(query)}&vqd=${encodeURIComponent(vqd)}&f=,,,&p=1`,
    { headers: { "user-agent": UA, "accept": "application/json" } });
  if (!api.ok) throw new Error(`image search failed: HTTP ${api.status}`);
  return parseDuckImages(await api.text(), limit);
}

/**
 * Ask the model for its 5 product names, then grab one clean product-shot
 * image per product. Slow sites are skipped — a report with 3 images beats
 * one that timed out. Never throws.
 */
export async function productImages(answerText) {
  const names = productNames(answerText);
  if (!names.length) return [];
  const out = [];
  for (const name of names.slice(0, 5)) {
    try {
      const imgs = await imageSearch(`${name} product`);
      if (imgs.length) out.push({ name, image: imgs[0].image, source: imgs[0].source });
    } catch { /* skip this one */ }
  }
  return out;
}

/** Pull the numbered product names from Charlie's answer ("1. **Name**"). */
export function productNames(answerText) {
  const out = [];
  const re = /^\s*\d+\.\s*\*\*([^*]+)\*\*/gm;
  let m;
  while ((m = re.exec(answerText)) && out.length < 5) {
    const n = m[1].replace(/["""']/g, "").trim();
    if (n) out.push(n);
  }
  return out;
}

/** The relay-safe block appended to Charlie's answer for Jarvis and the UI. */
export function imagesBlock(images) {
  if (!images.length) return "";
  return "\n\nIMAGES:\n" + images.map((i) => `PRODUCT: ${i.name}\nIMAGE_URL: ${i.image}`).join("\n");
}

// ================= main (only when run directly — importing Charlie must stay side-effect free) =================

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const DEFAULT_Q = "Suggest 5 trending product ideas that could sell on e-commerce platforms in India right now.";
  const question = process.argv.slice(2).join(" ").trim() || DEFAULT_Q;
  const QUERIES = [
    "trending products to sell online India",
    "best selling products online India this month",
  ];  try {
    const { evidence, errors } = await researchWeb(QUERIES);
    if (process.env.CHARLIE_DEBUG) {
      console.error(`[charlie] pages read: ${evidence.length}, errors: ${errors.length}`);
      for (const e of evidence) console.error(`[charlie]   ${e.url}`);
    }
    const answer = evidence.length
      ? await charlieThink(question, evidence)
      : await charlieFromMemory(question, errors);
    if (!answer) throw new Error("Charlie got an empty answer from the model");
    // Product images: best-effort — if the image search fails the text answer
    // still goes out, just without the IMAGES block.
    let extra = "";
    try {
      const imgs = await productImages(answer);
      extra = imagesBlock(imgs);
      if (process.env.CHARLIE_DEBUG) console.error(`[charlie] images found: ${imgs.length}`);
    } catch (e) {
      if (process.env.CHARLIE_DEBUG) console.error(`[charlie] image search failed: ${e.message}`);
    }
    // Small models sometimes forget the Sources line — append the pages he
    // ACTUALLY read so the user can always verify. Never fabricates sources.
    const out = /sources?:/i.test(answer) || !evidence.length
      ? answer
      : `${answer}\n\nSources Charlie read today:\n${evidence.slice(0, 3).map((e) => `- ${e.url}`).join("\n")}`;
    console.log(out + extra);
  } catch (e) {
    console.error(`Charlie could not think: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
