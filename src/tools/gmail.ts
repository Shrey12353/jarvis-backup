/**
 * Gmail for Jarvis — zero-dependency IMAP/SMTP client.
 *
 * Setup is login-only (the user is not a coder): they create a Google
 * "App Password" (their normal password never touches this app), put it in
 * .env as GMAIL_USER / GMAIL_APP_PASSWORD — or just ask Jarvis, who opens
 * the right pages in a real browser window and waits.
 *
 * Read-only checks (inbox, brief) are "ask"-free; SENDING always requires
 * the user's approval card first. Nothing leaves the PC except TLS to Google.
 */
import tls from "node:tls";
import { run as runProc } from "../core/proc.js";

const IMAP_HOST = "imap.gmail.com";
const SMTP_HOST = "smtp.gmail.com";
const SMTP_PORT = 465;

export function gmailConfigured(): boolean {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

function gmailCreds(): { user: string; pass: string } {
  const user = process.env.GMAIL_USER ?? "";
  const pass = process.env.GMAIL_APP_PASSWORD ?? "";
  if (!user || !pass) {
    throw new Error(
      "Gmail is not set up yet. Open the setup page for the user (gmail_setup_login tool) — they create a Google App Password, then it goes in .env as GMAIL_USER and GMAIL_APP_PASSWORD."
    );
  }
  return { user, pass };
}

// ================= low-level IMAP =================

/** RFC 2047 /=?utf-8?B?...?= header decoding (Base64 and Quoted-Printable). */
export function decodeHeader(value: string): string {
  return value
    .replace(/=\?([^?]+)\?([bB])\?([^?]*)\?=/g, (_all, _cs, _enc, data) => {
      try { return Buffer.from(data, "base64").toString("utf8"); } catch { return _all; }
    })
    .replace(/=\?([^?]+)\?[qQ]\?([^?]*)\?=/g, (_all, _cs, data) => {
      try { return qpDecode(String(data).replace(/_/g, " ")); } catch { return _all; }
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** Quoted-printable decode (byte-accurate, UTF-8 aware). */
export function qpDecode(s: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "=" && /^[0-9A-F]{2}$/i.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (c === "=" && /\r?\n/.test(s.slice(i + 1, i + 3))) {
      i += s.slice(i + 1, i + 3).length; // soft line break — removed entirely
    } else {
      bytes.push(s.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

export interface MailSummary {
  uid: number;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  seen: boolean;
}

/** Parse the UID FETCH listing into clean mail summaries. Exported for tests. */
export function parseMailList(raw: string): MailSummary[] {
  const out: MailSummary[] = [];
  const lines = raw.split(/\r?\n/);
  let cur: MailSummary | null = null;
  let inSnippet = false;
  let snippetLines: string[] = [];
  for (const line of lines) {
    const fetchStart = /^\*\s+\d+\s+FETCH\s+\(/.exec(line);
    if (fetchStart) {
      if (cur) pushMail(out, cur, snippetLines);
      cur = { uid: 0, from: "", subject: "(no subject)", date: "", snippet: "", seen: false };
      inSnippet = false;
      snippetLines = [];
      const uidM = /\bUID\s+(\d+)/.exec(line);
      if (uidM) cur.uid = Number(uidM[1]);
      const flagsM = /FLAGS\s+\(([^)]*)\)/.exec(line);
      if (flagsM) cur.seen = flagsM[1].includes("\\Seen");
      const dateM = /INTERNALDATE\s+"([^"]+)"/.exec(line);
      if (dateM) cur.date = dateM[1];
      continue;
    }
    if (!cur) continue;
    if (/^\)/.test(line)) { // end of this entry
      pushMail(out, cur, snippetLines);
      cur = null;
      inSnippet = false;
      continue;
    }
    if (inSnippet) { snippetLines.push(line); continue; }
    const hm = /^\s*(From|Subject|Date):\s*(.*)$/i.exec(line);
    if (hm) {
      const v = decodeHeader(hm[2]);
      const key = hm[1].toLowerCase();
      if (key === "from") cur.from = v;
      else if (key === "subject" && v) cur.subject = v;
      else cur.date = cur.date || v;
      continue;
    }
    if (/^\s*BODY\[TEXT\]/i.test(line)) inSnippet = true;
  }
  if (cur) pushMail(out, cur, snippetLines);
  return out.filter((m) => m.uid > 0);
}

function pushMail(out: MailSummary[], cur: MailSummary, snippetLines: string[]): void {
  if (out.some((m) => m.uid === cur!.uid)) return;
  let snip = snippetLines.join(""); // IMAP hard-wraps literals mid-word — no separator
  if (/<[a-z!]/i.test(snip)) snip = snip.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
  cur.snippet = qpDecode(snip).replace(/\s+/g, " ").trim().slice(0, 160);
  out.push(cur);
}

class ImapClient {
  private sock: tls.TLSSocket;
  private buf = "";
  private lines: string[] = [];
  private waiter: (() => void) | null = null;
  private tagN = 0;

  constructor(sock: tls.TLSSocket) {
    this.sock = sock;
    sock.on("data", (d: Buffer) => this.push(d));
    sock.on("error", () => { /* surfaced via timeout/close */ });
  }

  private push(d: Buffer): void {
    this.buf += d.toString("utf8");
    let i;
    while ((i = this.buf.indexOf("\r\n")) !== -1) {
      this.lines.push(this.buf.slice(0, i));
      this.buf = this.buf.slice(i + 2);
    }
    this.waiter?.();
    this.waiter = null;
  }

  async waitLine(): Promise<string> {
    for (;;) {
      if (this.lines.length) return this.lines.shift() as string;
      await new Promise<void>((r) => { this.waiter = r; });
    }
  }

  async cmd(text: string, timeoutMs = 20_000): Promise<string[]> {
    const tag = `A${++this.tagN}`;
    this.sock.write(`${tag} ${text}\r\n`);
    const out: string[] = [];
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`IMAP timeout on ${text.split(" ")[0]}`);
      const l = await Promise.race([this.waitLine(), sleepUntil(deadline)]);
      if (l === undefined) throw new Error(`IMAP timeout on ${text.split(" ")[0]}`);
      if (l.startsWith(tag + " ")) {
        if (/^OK/i.test(l.slice(tag.length + 1).trim())) return out;
        throw new Error(`IMAP error: ${l.slice(tag.length + 1).trim().slice(0, 140)}`);
      }
      out.push(l);
    }
  }

  close(): void {
    try { this.sock.write(`A_END LOGOUT\r\n`); } catch { /* ignore */ }
    setTimeout(() => { try { this.sock.destroy(); } catch { /* ignore */ } }, 300);
  }
}

function sleepUntil(deadline: number): Promise<undefined> {
  return new Promise((r) => setTimeout(() => r(undefined), Math.max(50, deadline - Date.now())));
}

async function withImap<T>(fn: (imap: ImapClient) => Promise<T>): Promise<T> {
  const { user, pass } = gmailCreds();
  const sock = await new Promise<tls.TLSSocket>((resolve, reject) => {
    const s = tls.connect({ host: IMAP_HOST, port: 993, servername: IMAP_HOST }, () => resolve(s));
    s.setTimeout(15_000, () => { s.destroy(); reject(new Error("could not reach Gmail (timeout)")); });
    s.on("error", (e) => reject(new Error(`could not reach Gmail: ${e.message}`)));
  });
  const imap = new ImapClient(sock);
  try {
    const greet = await imap.waitLine();
    if (!/^\*\s+OK/.test(greet)) throw new Error("Gmail greeted strangely");
    await imap.cmd(`LOGIN ${JSON.stringify(user)} ${JSON.stringify(pass)}`);
    return await fn(imap);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/AUTHENTICATIONFAILED|INVALID credentials|LOGIN failed/i.test(msg)) {
      throw new Error(
        "Gmail rejected the app password. It may have been changed or revoked — create a fresh one (myaccount.google.com/apppasswords) and update GMAIL_APP_PASSWORD in .env."
      );
    }
    throw e;
  } finally {
    imap.close();
  }
}

export function parseSearchUids(lines: string[], max: number): number[] {
  for (const l of lines) {
    const m = /^\*\s+(?:E)?SEARCH(.*)$/i.exec(l);
    if (m) {
      const uids = (m[1].match(/\d+/g) ?? []).map(Number);
      return uids.slice(-max);
    }
  }
  return [];
}

/** Newest `max` mails, unread-first when unseenOnly. */
export async function checkGmail(opts: { unseenOnly?: boolean; max?: number } = {}): Promise<MailSummary[]> {
  const max = opts.max ?? 10;
  return withImap(async (imap) => {
    await imap.cmd("SELECT INBOX");
    const query = opts.unseenOnly === false ? "ALL" : "UNSEEN";
    const found = await imap.cmd(`UID SEARCH ${query}`);
    const uids = parseSearchUids(found, max);
    if (!uids.length) return [];
    const listing = await imap.cmd(
      `UID FETCH ${uids.join(",")} (UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)] BODY.PEEK[TEXT]<0.400>)`
    );
    return parseMailList(listing.join("\r\n"));
  });
}

/** Full readable text of one mail (headers + body, cleaned, capped). */
export async function readGmail(uid: string): Promise<string> {
  if (!/^\d+$/.test(uid)) throw new Error("uid must be a number (see gmail_inbox)");
  return withImap(async (imap) => {
    await imap.cmd("SELECT INBOX");
    const res = await imap.cmd(
      `UID FETCH ${uid} (BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)] BODY.PEEK[TEXT]<0.6000>)`
    );
    const raw = res.join("\r\n");
    const from = decodeHeader(/From:\s*(.*)/i.exec(raw)?.[1] ?? "");
    const to = decodeHeader(/To:\s*(.*)/i.exec(raw)?.[1] ?? "");
    const subject = decodeHeader(/Subject:\s*(.*)/i.exec(raw)?.[1] ?? "(no subject)");
    let body = "";
    const litM = /BODY\[TEXT\]<0>\s*\{(\d+)\}\r?\n/.exec(raw);
    if (litM) {
      const start = (litM.index ?? 0) + litM[0].length;
      body = raw.slice(start, start + Math.min(Number(litM[1]), 6000));
      if (/<[a-z!]/i.test(body)) body = body.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, "\n");
      body = qpDecode(body).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    }
    return `From: ${from}\nTo: ${to}\nSubject: ${subject}\n\n${body || "(body could not be displayed — likely an image-only or unusual mail)"}`;
  });
}

/** Headers needed to quote-reply. */
async function replyTarget(uid: string): Promise<{ to: string; subject: string }> {
  return withImap(async (imap) => {
    await imap.cmd("SELECT INBOX");
    const res = await imap.cmd(`UID FETCH ${uid} (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT)])`);
    const raw = res.join("\r\n");
    const replyTo = decodeHeader(/From:\s*(.*)/i.exec(raw)?.[1] ?? "");
    const subject = decodeHeader(/Subject:\s*(.*)/i.exec(raw)?.[1] ?? "");
    const addr = /[\w.+-]+@[\w.-]+/.exec(replyTo)?.[0] ?? "";
    if (!addr) throw new Error("could not find a reply address on that mail");
    return { to: addr, subject: subject.startsWith("Re:") ? subject : `Re: ${subject}` };
  });
}

// ================= SMTP (sending) =================

async function smtpSend(user: string, pass: string, mailFrom: string, rcpt: string, message: string): Promise<void> {
  const sock = await new Promise<tls.TLSSocket>((resolve, reject) => {
    const s = tls.connect({ host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST }, () => resolve(s));
    s.setTimeout(15_000, () => { s.destroy(); reject(new Error("SMTP timeout")); });
    s.on("error", (e) => reject(new Error(`SMTP failed: ${e.message}`)));
  });
  try {
    const read = (): Promise<string> => new Promise((resolve, reject) => {
      let data = "";
      const onD = (d: Buffer) => { data += d.toString("utf8"); if (/\n\d{3}[ -]/.test(data)) { sock.off("data", onD); resolve(data); } };
      sock.on("data", onD);
      setTimeout(() => { sock.off("data", onD); reject(new Error("SMTP timeout")); }, 15_000);
    });
    const expect = async (code: string, step: string): Promise<void> => {
      const r = await read();
      if (!r.startsWith(code)) throw new Error(`SMTP ${step} rejected: ${r.split("\r\n")[0].slice(0, 120)}`);
    };
    await expect("220", "greeting");
    sock.write(`EHLO jarvis.local\r\n`);
    await expect("250", "EHLO");
    const auth = Buffer.from(`\0${user}\0${pass}`).toString("base64");
    sock.write(`AUTH PLAIN ${auth}\r\n`);
    await expect("235", "login (check the app password)");
    sock.write(`MAIL FROM:<${mailFrom}>\r\n`);
    await expect("250", "MAIL FROM");
    sock.write(`RCPT TO:<${rcpt}>\r\n`);
    await expect("250", "RCPT TO");
    const dotStuffed = message.replace(/\r?\n\./g, "\n..");
    sock.write(`DATA\r\n`);
    await expect("354", "DATA");
    sock.write(dotStuffed + "\r\n.\r\n");
    await expect("250", "message accept");
    sock.write(`QUIT\r\n`);
  } finally {
    setTimeout(() => { try { sock.destroy(); } catch { /* ignore */ } }, 200);
  }
}

function buildMessage(from: string, to: string, subject: string, body: string, extraHeaders: string = ""): string {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 8bit`,
    ...extraHeaders.split("\n").filter(Boolean),
    "",
  ].join("\r\n");
  return headers + body.replace(/\r?\n/g, "\r\n");
}

/** Send a plain reply to a mail in the inbox (caller enforces approval). */
export async function replyGmail(uid: string, message: string): Promise<string> {
  const { user } = gmailCreds();
  const { to, subject } = await replyTarget(uid);
  const message_ = buildMessage(user, to, subject, message);
  await smtpSend(user, process.env.GMAIL_APP_PASSWORD ?? "", user, to, message_);
  return `Reply sent to ${to} (subject "${subject}").`;
}

/** Compose a brand-new mail (caller enforces approval). */
export async function sendGmail(to: string, subject: string, body: string): Promise<string> {
  if (!/^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i.test(to)) throw new Error(`"${to}" doesn't look like an email address`);
  const { user } = gmailCreds();
  const message = buildMessage(user, to, subject, body);
  await smtpSend(user, process.env.GMAIL_APP_PASSWORD ?? "", user, to, message);
  return `Mail sent to ${to} (subject "${subject}").`;
}

// ================= the morning brief =================

/** One-paragraph-per-mail digest for the daily report. Never throws. */
export async function gmailBriefing(max = 8): Promise<string> {
  if (!gmailConfigured()) {
    return "(Email brief skipped — Gmail isn't set up yet. In the chat, just say: set up my email)";
  }
  try {
    const mails = await checkGmail({ unseenOnly: true, max });
    if (!mails.length) return "No unread emails — inbox is clear.";
    const lines = [`Unread emails: ${mails.length}`];
    mails.forEach((m, i) => {
      lines.push(`${i + 1}. [uid ${m.uid}] ${m.subject}`);
      lines.push(`   from ${m.from || "(unknown)"} — ${m.snippet || "(no preview)"}`);
    });
    lines.push("(Ask Jarvis to read any of them aloud, or to reply — he'll ask before sending.)");
    return lines.join("\n");
  } catch (e) {
    return `(Email brief unavailable: ${e instanceof Error ? e.message : String(e)})`;
  }
}

/** Open Google's app-password page in a real browser window for the user to sign in. */
export async function openGmailSetup(): Promise<string> {
  const url = "https://myaccount.google.com/apppasswords";
  const r = await runProc(`start "" "${url}"`, {
    shell: process.platform === "win32" ? true : "bash",
    timeoutMs: 15_000,
  });
  if (r.code !== 0 && !r.stdout) {
    await runProc(`explorer "${url}"`, { timeoutMs: 10_000 });
  }
  return [
    "I opened the Google App Passwords page in your browser.",
    "Steps (one-time, ~2 minutes):",
    "  1. Sign in to your Google account.",
    "  2. If asked, enable 2-Step Verification first (Google requires it for app passwords).",
    "  3. Click 'Create', name it jarvis, copy the 16-letter password it shows.",
    "Then tell me the 16 letters (or paste them into the .env file as GMAIL_APP_PASSWORD) and your Gmail address as GMAIL_USER — after that I can read and send mail for you.",
  ].join("\n");
}

// ================= browser-based mail (no app password needed) =================

/**
 * Preferred path for a non-coder: use the agent's persistent browser profile
 * (the user signs into Gmail ONCE in the window that pops up; the profile
 * remembers). Reads the inbox from mail.google.com directly. Falls back to
 * nothing — errors are plain-language.
 */
async function browserInbox(max = 10): Promise<string> {
  const { openOnAgentProfile } = await import("./browser.js");
  const { DEFAULT_CONFIG } = await import("../core/config.js");
  const ctx = { cfg: { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, workspace: process.env.JARVIS_WORKSPACE || "" } } } as never;
  const p = await openOnAgentProfile(ctx, "https://mail.google.com/mail/u/0/#inbox");
  await p.waitForTimeout(3_000);
  const url = p.url();
  if (/accounts\.google\.com|ServiceLogin|signin/i.test(url)) {
    return [
      "Gmail needs a one-time sign-in: a browser window just opened at the Google login page.",
      "Sign in (your normal username and password — this is Google's own page), then tell me 'check my email' again. You will NOT need to sign in every time.",
    ].join("\n");
  }
  const rows = await p.evaluate(() => {
    const out: string[] = [];
    const rows = Array.from(document.querySelectorAll("tr.zA")) as HTMLElement[];
    for (const r of rows.slice(0, 25)) {
      const who = (r.querySelector(".yW span[email]") as HTMLElement)?.getAttribute("email") || (r.querySelector(".yW")?.textContent ?? "").trim();
      const subj = (r.querySelector(".y6")?.textContent ?? "").trim() || (r.querySelector(".bog")?.textContent ?? "").trim();
      const snippet = (r.querySelector(".yP, .bqe")?.textContent ?? "").trim();
      const unread = r.classList.contains("zE");
      const date = (r.querySelector(".xW")?.textContent ?? "").trim();
      out.push(`${unread ? "UNREAD" : "read"} | ${who} | ${subj} | ${snippet.slice(0, 80)} | ${date}`);
    }
    return out;
  });
  if (!rows.length) return "(Gmail opened but no message rows were found — the layout may have changed, or the inbox is empty.)";
  const unread = rows.filter((r) => r.startsWith("UNREAD"));
  const list = (max && unread.length ? unread : rows).slice(0, max);
  return `Gmail inbox (newest first, ${unread.length} unread of ${rows.length} shown):\n` + list.map((r, i) => `${i + 1}. ${r}`).join("\n");
}

/** Read one conversation from the Gmail web UI by opening it. */
async function browserRead(subjectPart: string): Promise<string> {
  const { openOnAgentProfile } = await import("./browser.js");
  const { DEFAULT_CONFIG } = await import("../core/config.js");
  const ctx = { cfg: { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, workspace: process.env.JARVIS_WORKSPACE || "" } } } as never;
  const q = encodeURIComponent(`subject:(${subjectPart.slice(0, 60)})`);
  const p = await openOnAgentProfile(ctx, `https://mail.google.com/mail/u/0/#search/${q}`);
  await p.waitForTimeout(3_000);
  const url = p.url();
  if (/accounts\.google\.com|ServiceLogin|signin/i.test(url)) {
    return "Gmail needs a one-time sign-in first — say 'check my email' and sign in at the window that opens.";
  }
  const first = await p.$("tr.zA");
  if (!first) return `No mail matched "${subjectPart}".`;
  await first.click();
  await p.waitForTimeout(3_000);
  const body = await p.evaluate(() => {
    const subj = (document.querySelector("h2.hP")?.textContent ?? "").trim();
    const senders = (Array.from(document.querySelectorAll("span.gD")) as unknown as HTMLElement[]).map((e) => e.getAttribute("email") || e.textContent || "");
    const text = (document.querySelector("div.ii.gt")?.textContent ?? "").replace(/\s+\n/g, "\n").trim();
    return `Subject: ${subj}\nFrom: ${senders.join(", ")}\n\n${text.slice(0, 4_000)}`;
  });
  return body || "(could not read the conversation body)";
}

/** Compose-and-send through the Gmail web UI (approval handled by the tool tier). */
async function browserSend(to: string, subject: string, body: string): Promise<string> {
  const { openOnAgentProfile } = await import("./browser.js");
  const { DEFAULT_CONFIG } = await import("../core/config.js");
  const ctx = { cfg: { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, workspace: process.env.JARVIS_WORKSPACE || "" } } } as never;
  const p = await openOnAgentProfile(ctx, "https://mail.google.com/mail/u/0/#inbox");
  await p.waitForTimeout(2_500);
  if (/accounts\.google\.com|ServiceLogin|signin/i.test(p.url())) {
    return "Gmail needs a one-time sign-in first — say 'check my email' and sign in at the window that opens.";
  }
  await p.click("div.T-I.T-I-KE.L3").catch(async () => { await p.keyboard.press("c"); }); // Compose button (or keyboard shortcut)
  await p.waitForSelector("textarea[name=to], input[name=to]", { timeout: 10_000 });
  await p.fill("textarea[name=to], input[name=to]", to);
  await p.fill("input[name=subjectbox]", subject);
  await p.fill("div.Am.AO editable, div[aria-label='Message Body']", body);
  await p.click("div[aria-label='Send \u2026'], div.T-I.J-J5-Ji.aoO.T-I-atl.L3").catch(async () => {
    await p.keyboard.press("Control+Enter");
  });
  await p.waitForTimeout(2_500);
  return `Mail sent through Gmail to ${to} (subject "${subject}").`;
}

// ================= agent tools =================

import type { Tool } from "./types.js";

export const gmailTools: Tool[] = [
  {
    name: "gmail_setup_login",
    description:
      "Open Gmail in the agent's browser window so the user can sign in ONE time (their normal Google account — no app password needed). Use when the user asks to set up email or when other gmail tools report a sign-in is needed.",
    safety: "auto",
    parameters: { type: "object", properties: {} },
    async run(_args, ctx) {
      const { openOnAgentProfile } = await import("./browser.js");
      await openOnAgentProfile(ctx, "https://mail.google.com/");
      return [
        "A browser window is open at Gmail.",
        "Sign in once with your normal Google account (this is Google's own page).",
        "After that just tell me things like 'check my email' — you stay signed in.",
      ].join("\n");
    },
  },
  {
    name: "gmail_inbox",
    description:
      "List the newest emails (unread first): sender, subject, preview. Works through the signed-in Gmail window; if a sign-in is needed it says exactly that. Read-only, safe.",
    safety: "auto",
    parameters: {
      type: "object",
      properties: { max: { type: "number", description: "How many (default 10)" } },
    },
    async run(args) {
      try {
        return await browserInbox(Number(args.max ?? 10));
      } catch (e) {
        if (gmailConfigured()) {
          try {
            const mails = await checkGmail({ unseenOnly: true, max: Number(args.max ?? 10) });
            if (!mails.length) return "No unread emails — inbox is clear.";
            return mails.map((m, i) => `${i + 1}. [uid ${m.uid}] ${m.subject}\n   from: ${m.from}\n   ${m.snippet}`).join("\n");
          } catch (e2) {
            return `Gmail error: ${e2 instanceof Error ? e2.message : String(e2)}`;
          }
        }
        return `Could not open Gmail: ${e instanceof Error ? e.message : String(e)}. Say 'set up my email' and sign in at the window that opens.`;
      }
    },
  },
  {
    name: "gmail_read",
    description: 'Read one email in full. Pass the subject text (or a distinctive word from it) from gmail_inbox. Read-only, safe.',
    safety: "auto",
    parameters: {
      type: "object",
      properties: { uid: { type: "string", description: "uid (app-password mode) OR subject text to search (browser mode)" } },
      required: ["uid"],
    },
    async run(args, ctx) {
      const q = String(args.uid ?? "").trim();
      if (/^\d+$/.test(q) && gmailConfigured()) {
        try { return await readGmail(q); } catch { /* fall through to browser */ }
      }
      return browserRead(q);
    },
  },
  {
    name: "gmail_reply",
    description:
      "Reply to an email. Pass the subject text of the mail and the reply text. ALWAYS show the user the exact reply first (this tool already asks via the approval card). Never send without the user having seen what will be sent.",
    safety: "ask",
    parameters: {
      type: "object",
      properties: {
        uid: { type: "string", description: "uid (app-password mode) OR subject text to search (browser mode)" },
        message: { type: "string", description: "The reply text to send" },
      },
      required: ["uid", "message"],
    },
    async run(args) {
      const q = String(args.uid ?? "").trim();
      const msg = String(args.message ?? "");
      if (/^\d+$/.test(q) && gmailConfigured()) {
        try { return await replyGmail(q, msg); } catch { /* fall through */ }
      }
      const full = await browserRead(q);
      const to = /[\w.+-]+@[\w.-]+/.exec(full)?.[0];
      if (!to) return "Error: could not find the sender's address on that mail.";
      const subj = /^Subject:\s*(.*)$/m.exec(full)?.[1] ?? "Re: your mail";
      return browserSend(to, subj.startsWith("Re:") ? subj : `Re: ${subj}`, msg);
    },
  },
  {
    name: "gmail_send",
    description:
      "Compose and send a new email. ALWAYS show the user the recipient, subject and text first (this tool already asks via the approval card). Never invent recipients.",
    safety: "ask",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string" },
        body: { type: "string", description: "Plain-text mail body" },
      },
      required: ["to", "subject", "body"],
    },
    async run(args) {
      const to = String(args.to ?? "").trim();
      if (!/^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i.test(to)) return `Error: "${to}" doesn't look like an email address.`;
      if (gmailConfigured()) {
        try { return await sendGmail(to, String(args.subject ?? "(no subject)").trim(), String(args.body ?? "")); } catch { /* fall through */ }
      }
      return browserSend(to, String(args.subject ?? "(no subject)").trim(), String(args.body ?? ""));
    },
  },
];
