import type { Tool } from "./types.js";
import { truncate } from "../core/util.js";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function duckDuckGoSearch(query: string): Promise<SearchResult[]> {
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Jarvis-Agent/0.1",
    },
    body: new URLSearchParams({ q: query }).toString(),
  });
  if (!res.ok) throw new Error(`search failed: ${res.status}`);
  const html = await res.text();
  const results: SearchResult[] = [];
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = snipRe.exec(html)) && snippets.length < 10) snippets.push(stripTags(m[1]));
  let i = 0;
  while ((m = linkRe.exec(html)) && results.length < 8) {
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

function stripTags(s: string): string {
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

export const webTools: Tool[] = [
  {
    name: "web_search",
    description:
      "Search the web without any API key. Returns top results with title, URL, snippet. Follow up with browser_navigate + browser_extract to read a page fully.",
    safety: "auto",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
    },
    async run(args) {
      const q = String(args.query ?? "").trim();
      if (!q) return "Error: empty query";
      const results = await duckDuckGoSearch(q);
      if (!results.length) return "No results found.";
      return results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${truncate(r.snippet, 200)}`)
        .join("\n");
    },
  },
];
