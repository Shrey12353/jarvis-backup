import path from "node:path";
import { promises as fsp } from "node:fs";
import type { BrowserContext, Page } from "playwright";
import type { Tool, ToolContext } from "./types.js";
import { truncate } from "../core/util.js";

let context: BrowserContext | null = null;
let page: Page | null = null;

/**
 * Persistent profile: cookies and logins SURVIVE restarts, so the user signs
 * in to Gmail etc. once and stays signed in (used by the scheduled morning
 * mail brief too).
 */
const PROFILE_DIR = path.join(process.cwd(), "data", "browser-profile");

/**
 * A crash or a killed process leaves Chromium's profile lock behind, and then
 * every later launch fails with "Opening in existing browser session". Clearing
 * those three tiny lock files is what makes the Gmail window open again.
 */
async function clearStaleProfileLocks(): Promise<boolean> {
  let cleared = false;
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try {
      await fsp.rm(path.join(PROFILE_DIR, name), { force: true });
      cleared = true;
    } catch {
      /* best-effort */
    }
  }
  return cleared;
}

async function getContext(ctx: ToolContext): Promise<BrowserContext> {
  if (context) return context;
  const { chromium } = await import("playwright");
  // Google refuses sign-in from Playwright's bundled Chromium ("this browser
  // may not be secure" -> login loops / "no permission"). The user's REAL
  // Chrome is trusted by Google, so prefer the "chrome" channel; fall back to
  // bundled Chromium if Chrome isn't installed.
  const launch = (): Promise<BrowserContext> =>
    chromium.launchPersistentContext(PROFILE_DIR, {
      headless: ctx.cfg.browser.headless,
      channel: process.platform === "win32" ? "chrome" : undefined,
      args: ["--disable-blink-features=AutomationControlled"],
      viewport: { width: 1366, height: 900 },
      ignoreHTTPSErrors: true,
    });
  try {
    context = await launch();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/existing browser session|Singleton|ProcessSingleton|user data directory is already in use/i.test(msg)) {
      await clearStaleProfileLocks();
      context = await launch(); // one retry with a clean profile lock
    } else {
      throw e;
    }
  }
  context.setDefaultTimeout(15_000);
  return context;
}

async function getPage(ctx: ToolContext): Promise<Page> {
  if (page && !page.isClosed()) return page;
  const c = await getContext(ctx);
  page = await c.newPage();
  return page;
}

/** Open a URL on the shared persistent browser profile (for other tool modules). */
export async function openOnAgentProfile(ctx: ToolContext, url: string): Promise<Page> {
  const p = await getPage(ctx);
  await p.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  return p;
}

/** Compact DOM summary: interactive elements with refs the model can click/type via. */
async function domSummary(p: Page): Promise<string> {
  const items = await p.evaluate(() => {
    const els = Array.from(document.querySelectorAll("a, button, input, textarea, select, [role=button], [onclick]")) as HTMLElement[];
    return els.slice(0, 80).map((el, i) => {
      const tag = el.tagName.toLowerCase();
      const text = (el as HTMLAnchorElement).innerText || (el as HTMLInputElement).value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
      const ref = `e${i}`;
      (el as HTMLElement & { dataset: DOMStringMap }).dataset.agentRef = ref;
      const href = tag === "a" ? (el as HTMLAnchorElement).href : "";
      return `${ref}: <${tag}> ${text.trim().slice(0, 60).replace(/\s+/g, " ")}${href ? ` -> ${href.slice(0, 80)}` : ""}`;
    });
  });
  const title = await p.title();
  return `PAGE: ${title} (${p.url()})\nElements:\n${items.join("\n") || "(none found)"}`;
}

async function byRef(p: Page, ref: string) {
  const el = await p.$(`[data-agent-ref="${ref}"]`);
  if (!el) throw new Error(`ref ${ref} not found — call browser_navigate or browser_read again for fresh refs`);
  return el;
}

export function browserTools(): Tool[] {
  return [
    {
      name: "browser_navigate",
      description: "Open a URL in the browser. Returns the page title, URL, and clickable element list with refs (e0, e1...) for browser_click/browser_type.",
      safety: "auto",
      parameters: { type: "object", properties: { url: { type: "string", description: "Full URL including http(s)://" } }, required: ["url"] },
      async run(args, ctx) {
        const p = await getPage(ctx);
        await p.goto(String(args.url), { waitUntil: "domcontentloaded" });
        return domSummary(p);
      },
    },
    {
      name: "browser_read",
      description: "Re-read the current page's interactive elements (fresh refs) plus visible text.",
      safety: "auto",
      parameters: { type: "object", properties: {} },
      async run(args, ctx) {
        const p = await getPage(ctx);
        const summary = await domSummary(p);
        const text = truncate(await p.evaluate(() => document.body?.innerText ?? ""), 3_000);
        return `${summary}\n\nVisible text:\n${text}`;
      },
    },
    {
      name: "browser_click",
      description: "Click an element by ref (from browser_navigate/browser_read) or by CSS selector.",
      safety: "auto",
      parameters: { type: "object", properties: { ref: { type: "string", description: "Element ref like e3" }, selector: { type: "string", description: "Or a CSS selector" } } },
      async run(args, ctx) {
        const p = await getPage(ctx);
        const target = args.ref ? await byRef(p, String(args.ref)) : await p.$(String(args.selector));
        if (!target) return "Error: element not found";
        await target.click();
        await p.waitForTimeout(800);
        return domSummary(p);
      },
    },
    {
      name: "browser_type",
      description: "Type text into an input by ref or CSS selector. Set submit=true to press Enter after.",
      safety: "auto",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string" },
          selector: { type: "string" },
          text: { type: "string", description: "Text to type" },
          submit: { type: "boolean", description: "Press Enter afterwards" },
        },
        required: ["text"],
      },
      async run(args, ctx) {
        const p = await getPage(ctx);
        const target = args.ref ? await byRef(p, String(args.ref)) : await p.$(String(args.selector));
        if (!target) return "Error: element not found";
        await target.click();
        await target.fill(String(args.text));
        if (args.submit) await p.keyboard.press("Enter");
        await p.waitForTimeout(500);
        return domSummary(p);
      },
    },
    {
      name: "browser_extract",
      description: "Extract page text (optionally matching a CSS selector) — for reading articles, prices, search results.",
      safety: "auto",
      parameters: { type: "object", properties: { selector: { type: "string", description: "Optional CSS selector (default: body)" } } },
      async run(args, ctx) {
        const p = await getPage(ctx);
        const sel = String(args.selector || "body");
        const text = await p.$eval(sel, (el) => (el as HTMLElement).innerText).catch(() => "(selector not found)");
        return truncate(text, 6_000);
      },
    },
    {
      name: "browser_screenshot",
      description: "Save a PNG screenshot of the current page to the data folder and return the path.",
      safety: "auto",
      parameters: { type: "object", properties: { name: { type: "string", description: "Filename without extension" } } },
      async run(args, ctx) {
        const p = await getPage(ctx);
        const file = path.join(ctx.cfg.paths.data, "screenshots", `${String(args.name || "shot")}.png`);
        await p.screenshot({ path: file, fullPage: false });
        return `Saved ${file}`;
      },
    },
    {
      name: "browser_tabs",
      description: "List open tabs, switch by index, open a new tab, or close one.",
      safety: "auto",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "list | open | switch | close", enum: ["list", "open", "switch", "close"] },
          index: { type: "number", description: "Tab index for switch/close" },
          url: { type: "string", description: "URL for open" },
        },
        required: ["action"],
      },
      async run(args, ctx) {
        if (!context) return "Browser not started";
        const pages = context.pages();
        const action = String(args.action);
        if (action === "list") {
          return pages.map((pg, i) => `${i}: ${pg.url()}`).join("\n") || "(no tabs)";
        }
        if (action === "open" && args.url) {
          page = await context.newPage();
          await page.goto(String(args.url), { waitUntil: "domcontentloaded" });
          return domSummary(page);
        }
        const idx = Number(args.index ?? 0);
        const target = pages[idx];
        if (!target) return `No tab at index ${idx}`;
        if (action === "switch") {
          page = target;
          await page.bringToFront();
          return domSummary(page);
        }
        if (action === "close") {
          await target.close();
          if (page === target) page = pages.find((pg) => pg !== target) ?? null;
          return "Closed";
        }
        return "Unknown action";
      },
    },
  ];
}

export async function shutdownBrowser(): Promise<void> {
  try {
    await context?.close();
  } catch {
    /* ignore */
  }
  context = null;
  page = null;
}
