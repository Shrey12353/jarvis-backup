import path from "node:path";
import http from "node:http";
import { promises as fsp } from "node:fs";
import { execFile, execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { Browser, BrowserContext, Page } from "playwright";
import type { Tool, ToolContext } from "./types.js";
import { truncate } from "../core/util.js";

let context: BrowserContext | null = null;
let page: Page | null = null;
let joined = false; // true when we attached to a Chrome owned by another Jarvis process
let launchPromise: Promise<BrowserContext> | null = null;

/**
 * Persistent profile: cookies and logins SURVIVE restarts, so the user signs
 * in to Gmail etc. once and stays signed in (used by the scheduled morning
 * mail brief too).
 */
const PROFILE_DIR = path.join(process.cwd(), "data", "browser-profile");
const PROFILE_NEEDLE = PROFILE_DIR.toLowerCase();

/**
 * Cross-process sharing: EVERY Jarvis process (UI server, voice agent, run,
 * scheduled jobs) uses the SAME Chrome instance instead of each trying to
 * launch its own on the same profile — which is what caused the recurring
 * "Opening in existing browser session" failure.
 *
 * The first process to need the browser launches Chrome with a CDP debug
 * port and records the port + owner PID in data/browser-cdp.lock. Later
 * processes attach to that Chrome over CDP and share its profile/tabs.
 * If the recorded Chrome is gone (crash / kill / reboot), the stale lock is
 * ignored and the caller becomes the new owner.
 */
const CDP_PORT = 9222;
const CDP_HOST = `http://127.0.0.1:${CDP_PORT}`;
const LOCK_FILE = path.join(process.cwd(), "data", "browser-cdp.lock");

interface CdpLock {
  pid: number;
  port: number;
  startedAt: string;
}

function debug(msg: string): void {
  if (process.env.JARVIS_BROWSER_DEBUG) console.log(`[browser] ${msg}`);
}

function readCdpLock(): CdpLock | null {
  try {
    const raw = JSON.parse(readFileSync(LOCK_FILE, "utf8")) as CdpLock;
    return raw && typeof raw.pid === "number" ? raw : null;
  } catch {
    return null;
  }
}

function writeCdpLock(pid: number, port: number): void {
  try {
    mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    writeFileSync(LOCK_FILE, JSON.stringify({ pid, port, startedAt: new Date().toISOString() } satisfies CdpLock, null, 1));
  } catch {
    /* best-effort */
  }
}

/** Find the PID that owns the CDP listener (netstat), used when Playwright
 *  does not expose the child process (channel launches). */
function pidOfPortListener(port: number): number {
  try {
    const out = execSync(`netstat -ano | findstr ":${port}" | findstr "LISTENING"`, { timeout: 5000, windowsHide: true }).toString();
    const m = out.match(/\s(\d+)\s*$/m);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

async function removeCdpLock(): Promise<void> {
  try {
    await fsp.rm(LOCK_FILE, { force: true });
  } catch {
    /* best-effort */
  }
}

function httpGetJson(url: string, timeoutMs = 1500): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data) as Record<string, unknown>);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}

/** Is anything serving the CDP endpoint? */
async function cdpAlive(): Promise<boolean> {
  const v = await httpGetJson(`${CDP_HOST}/json/version`, 1500);
  return !!(v && v.Browser);
}

/** Does a process with this PID exist (and look like Chrome)? */
async function pidAlive(pid: number): Promise<boolean> {
  if (!pid || pid <= 0) return false;
  if (process.platform !== "win32") {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  return new Promise((resolve) => {
    execFile("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(false);
      resolve(String(stdout).toLowerCase().includes("chrome"));
    });
  });
}

/**
 * Kill ONLY agent-owned Chrome windows: chrome.exe processes whose command
 * line references OUR profile directory. The user's personal Chrome (normal
 * window, different profile) never matches and is never touched.
 */
const KILL_AGENT_CHROME_PS = `
$ErrorActionPreference = "SilentlyContinue"
$killed = 0
$procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"
foreach ($p in $procs) {
  $cl = [string]$p.CommandLine
  if ($cl -and $cl.ToLower().Contains('${PROFILE_NEEDLE}')) {
    Stop-Process -Id $p.ProcessId -Force
    $killed++
  }
}
Write-Output ("KILLED=" + $killed)
`;

export async function killAgentChrome(): Promise<number> {
  if (process.platform !== "win32") return 0;
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", KILL_AGENT_CHROME_PS],
      { timeout: 20000, windowsHide: true },
      (err, stdout) => {
        const m = String(stdout || "").match(/KILLED=(\d+)/);
        resolve(m ? Number(m[1]) : 0);
      }
    );
  });
}

/**
 * A crash or a killed process leaves Chromium's profile lock behind. Clearing
 * those three tiny lock files lets a fresh launch proceed.
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

/** Attach to the Chrome owned by another Jarvis process (via its CDP port).
 *  Patient: up to ~14s of retries — Chrome may still be starting up. */
async function tryJoinOverCdp(chromium: import("playwright").BrowserType): Promise<BrowserContext | null> {
  const deadline = Date.now() + 14_000;
  while (Date.now() < deadline) {
    if (await cdpAlive()) {
      try {
        const browser: Browser = await chromium.connectOverCDP(CDP_HOST, { timeout: 8000 });
        for (let i = 0; i < 10; i++) {
          const ctx = browser.contexts()[0];
          if (ctx) return ctx;
          await new Promise((r) => setTimeout(r, 300));
        }
        return await browser.newContext();
      } catch {
        /* Chrome busy — retry within the deadline */
      }
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  return null;
}

async function tryLaunchPersistent(ctx: ToolContext): Promise<BrowserContext> {
  const { chromium } = await import("playwright");
  // Google refuses sign-in from Playwright's bundled Chromium ("this browser
  // may not be secure" -> login loops / "no permission"). The user's REAL
  // Chrome is trusted by Google, so prefer the "chrome" channel; fall back to
  // bundled Chromium if Chrome isn't installed. The debug port lets sibling
  // Jarvis processes share this very browser instead of fighting over the
  // profile.
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless: ctx.cfg.browser.headless,
    channel: process.platform === "win32" ? "chrome" : undefined,
    args: ["--disable-blink-features=AutomationControlled", `--remote-debugging-port=${CDP_PORT}`],
    viewport: { width: 1366, height: 900 },
    ignoreHTTPSErrors: true,
    timeout: 60_000,
  });
}

async function launchAsOwner(ctx: ToolContext): Promise<BrowserContext> {
  const context0 = await tryLaunchPersistent(ctx);
  joined = false;
  try {
    const proc = (context0.browser() as { process?: () => { pid?: number } | null } | null)?.process?.();
    const pid = proc?.pid || pidOfPortListener(CDP_PORT);
    writeCdpLock(pid, CDP_PORT);
  } catch {
    writeCdpLock(pidOfPortListener(CDP_PORT), CDP_PORT);
  }
  return context0;
}

async function getContext(ctx: ToolContext): Promise<BrowserContext> {
  if (context) return context;
  if (launchPromise) return launchPromise;

  launchPromise = (async () => {
    const { chromium } = await import("playwright");

    // 1) Another Jarvis process may already own a browser — share it.
    //    NEVER launch a second Chrome while a live owner lock exists: two
    //    instances on one profile corrupt data and recreate the original bug.
    const lock = readCdpLock();
    if (lock) {
      const cdpUp = await cdpAlive();
      const ownerAlive = cdpUp || (await pidAlive(lock.pid));
      debug(`lock found: pid=${lock.pid} cdp=${cdpUp} ownerAlive=${ownerAlive}`);
      if (ownerAlive) {
        const shared = await tryJoinOverCdp(chromium);
        if (shared) {
          debug("joined existing browser over CDP");
          joined = true;
          return shared;
        }
        // Owner holds the profile but its CDP is unreachable (old-style
        // launch without debug port, or wedged Chrome). Attaching is
        // impossible and launching is forbidden — reap and take over.
        debug("owner alive but not joinable — reaping agent chrome and taking over");
        await killAgentChrome();
        await new Promise((r) => setTimeout(r, 1500));
        await clearStaleProfileLocks();
        await removeCdpLock();
        return await launchAsOwner(ctx);
      }
      debug("lock exists but owner is dead — taking over");
      await removeCdpLock();
      await clearStaleProfileLocks();
      try {
        return await launchAsOwner(ctx);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/existing browser session|Singleton|ProcessSingleton|user data directory|browser has been closed/i.test(msg)) {
          // A sibling raced us and owns the profile — join it instead.
          debug("launch blocked — joining the racing winner");
          const shared = await tryJoinOverCdp(chromium);
          if (shared) {
            joined = true;
            return shared;
          }
          await killAgentChrome();
          await new Promise((r) => setTimeout(r, 1500));
          await clearStaleProfileLocks();
          await removeCdpLock();
          return await launchAsOwner(ctx);
        }
        throw e;
      }
    }

    // 2) No lock file at all: clear stale artifacts and become the owner.
    debug("no lock file — becoming owner");
    await clearStaleProfileLocks();
    try {
      return await launchAsOwner(ctx);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/existing browser session|Singleton|ProcessSingleton|user data directory|browser has been closed/i.test(msg)) {
        debug("launch blocked — orphan or racing sibling; trying join, then reap");
        const shared = await tryJoinOverCdp(chromium);
        if (shared) {
          joined = true;
          return shared;
        }
        await killAgentChrome();
        await new Promise((r) => setTimeout(r, 1500));
        await clearStaleProfileLocks();
        await removeCdpLock();
        return await launchAsOwner(ctx);
      }
      throw e;
    }
  })();

  try {
    context = await launchPromise;
    context.setDefaultTimeout(15_000);
    return context;
  } catch (e) {
    launchPromise = null;
    throw e;
  } finally {
    launchPromise = null;
  }
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
    if (context) {
      if (joined) {
        // We only attached to a Chrome owned by another process: disconnect
        // (Browser.close() on a CDP connection just disconnects) and leave
        // the shared browser running for its real owner.
        await context.browser()?.close();
      } else {
        await context.close();
      }
    }
  } catch {
    /* ignore */
  }
  context = null;
  page = null;
  launchPromise = null;
  const wasOwner = !joined;
  joined = false;
  if (wasOwner) {
    await removeCdpLock();
  }
}
