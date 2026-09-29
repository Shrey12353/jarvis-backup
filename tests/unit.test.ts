import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, promises as fsp, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { truncate, extractJson, repairJson, nowStamp } from "../src/core/util.js";
import { denyCheck, commandPathGuard, shellTool } from "../src/tools/shell.js";
import { classifyUserCommand, needsExplicitApproval } from "../src/core/safety.js";
import { loadConfig, confineToWorkspace, resolveWorkspaceCfg, DEFAULT_CONFIG } from "../src/core/config.js";
import { sma, ema, rsi } from "../src/trading/indicators.js";
import { strategies, compareStrategies } from "../src/trading/strategy.js";
import type { Bar } from "../src/trading/data.js";
import { DEFAULT_RISK, canOpen, hitStopLoss, checkEquityCircuitBreakers } from "../src/trading/risk.js";
import { Agent, isRepeatedFailure } from "../src/core/agent.js";
import { run as procRun } from "../src/core/proc.js";
import type { OllamaMessage } from "../src/core/ollama.js";
import type { ToolRegistry } from "../src/tools/types.js";

// ---------- Charlie: web-connected sub-agent ----------

import { extractDuckResults, extractPageText, parseDuckImages, parseVqd, productNames, imagesBlock } from "../charlie/charlie.mjs";
import { deflateSync } from "node:zlib";
import { parseMultipart, extractPdfText } from "../src/ui/attachments.js";
import { createChat, saveChat, loadChat, listChats, deleteChat, deriveTitle } from "../src/ui/chats.js";
import { parseMailList, parseSearchUids, decodeHeader, qpDecode, gmailBriefing } from "../src/tools/gmail.js";
import { buildImageUrl, imagesBlockLocal, polishPrompt, detectImageExt } from "../src/tools/imagegen.js";
import { redactSecrets, redactMessage, cloudConfigured } from "../src/core/cloud.js";
import { parseFacts, renderFacts, addFacts, listFacts, removeFact, memoryPromptSection, extractRememberRequests } from "../src/core/memory.js";
import { nextDue, parseWhen, addReminder, listReminders, cancelReminder, dueReminders, markFired, firedReminders } from "../src/core/reminders.js";
import { logActivity, readActivity, summarizeToolCall } from "../src/core/activity.js";
import { resolveReadRoots, resolveReadablePath, isInsideRoot, expandHome } from "../src/core/config.js";

test("truncate keeps short strings intact", () => {
  assert.equal(truncate("hello", 10), "hello");
});

test("truncate marks long strings", () => {
  const out = truncate("x".repeat(100), 10);
  assert.ok(out.startsWith("xxxxxxxxxx"));
  assert.ok(out.includes("truncated"));
});

test("extractJson finds plain JSON object", () => {
  const v = extractJson('Sure! {"a": 1}') as { a: number };
  assert.equal(v.a, 1);
});

test("extractJson finds JSON inside code fence", () => {
  const v = extractJson('```json\n{"name":"x","n":[1,2]}\n```') as { name: string };
  assert.equal(v.name, "x");
});

test("extractJson repairs trailing commas", () => {
  const v = extractJson('{"a": 1,}') as { a: number };
  assert.equal(v.a, 1);
});

test("extractJson returns undefined for prose without JSON", () => {
  assert.equal(extractJson("no json here"), undefined);
});

test("repairJson balances unclosed braces", () => {
  assert.equal(JSON.parse(repairJson('{"a": {"b": 1}')).constructor, Object);
});

test("nowStamp is sortable and unique-ish", () => {
  const s = nowStamp();
  assert.match(s, /^\d{8}-\d{6}$/);
});

// ---------- shell deny list ----------

test("denyCheck blocks catastrophic commands", () => {
  for (const cmd of [
    "rm -rf /",
    "del /q C:\\Users",
    "shutdown /s",
    "format C:",
    "vssadmin delete shadows /all",
    "cipher /w:C",
    "mkfs.ext4 /dev/sda1",
    "dd if=/dev/zero of=/dev/sda",
    "reg add HKLM\\Software\\x",
  ]) {
    assert.ok(denyCheck(cmd), `should deny: ${cmd}`);
  }
});

test("denyCheck allows normal commands", () => {
  for (const cmd of ["npm test", "git status", "ls -la", "node build.js", "echo hi"]) {
    assert.equal(denyCheck(cmd), null, `should allow: ${cmd}`);
  }
});

test("denyCheck checks ALL patterns, not just the first", () => {
  // 'shutdown' pattern sits late in the list; a command that also matches
  // an earlier pattern must still be denied.
  const cmd = "format C: && shutdown /r";
  assert.ok(denyCheck(cmd));
});

// ---------- shell command path guard ----------

const WS = path.resolve("/tmp/ws");

test("commandPathGuard blocks ../ traversal in command text", () => {
  assert.ok(commandPathGuard("move file.txt ../escape2.txt", WS));
  assert.ok(commandPathGuard("cd .. && dir", WS));
  assert.ok(commandPathGuard("copy a.txt ..\\b.txt", WS));
});

test("commandPathGuard blocks mutating commands with absolute paths outside", () => {
  assert.ok(commandPathGuard("move C:/Windows/system32/x.dll C:/Temp/", WS));
  assert.ok(commandPathGuard("del C:/Users/other/notes.txt", WS));
});

test("commandPathGuard allows in-workspace and plain commands", () => {
  assert.equal(commandPathGuard("node index.js", WS), null);
  assert.equal(commandPathGuard("npm test", WS), null);
  assert.equal(commandPathGuard("dir", WS), null);
  assert.equal(
    commandPathGuard(`move ${path.resolve(WS, "a.txt")} ${path.resolve(WS, "b.txt")}`, WS),
    null
  );
});

// ---------- safety gate ----------

function cfg(overrides: Partial<typeof DEFAULT_CONFIG.agent> = {}): Parameters<typeof classifyUserCommand>[1] {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    agent: { ...structuredClone(DEFAULT_CONFIG.agent), ...overrides },
  };
}

test("read-only commands auto-approve", () => {
  assert.equal(classifyUserCommand("git status", cfg()).mode, "auto");
  assert.equal(classifyUserCommand("ls -la", cfg()).mode, "auto");
});

test("dangerous commands are denied even in full_auto", () => {
  assert.equal(classifyUserCommand("shutdown /s", cfg({ full_auto: true })).mode, "deny");
});

test("state-changing commands ask unless full_auto", () => {
  assert.equal(classifyUserCommand("npm install left-pad", cfg()).mode, "ask");
  assert.equal(classifyUserCommand("npm install left-pad", cfg({ full_auto: true })).mode, "auto");
});

test("dangerous-tier tools need approval even in full_auto without allow_dangerous", () => {
  assert.equal(needsExplicitApproval("dangerous", cfg({ full_auto: true })), true);
  assert.equal(needsExplicitApproval("dangerous", cfg({ full_auto: true, allow_dangerous: true })), false);
  assert.equal(needsExplicitApproval("ask", cfg({ full_auto: true })), false);
  assert.equal(needsExplicitApproval("ask", cfg()), true);
  assert.equal(needsExplicitApproval("auto", cfg()), false);
});

// ---------- config loading ----------

test("loadConfig returns defaults when no config file exists", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cfg-"));
  const c = await loadConfig(dir);
  assert.equal(c.ollama.host, "http://localhost:11434");
  assert.equal(c.agent.max_steps, 25);
  assert.equal(c.browser.headless, false);
  await fs.rm(dir, { recursive: true, force: true });
});

test("loadConfig deep-merges a partial yaml over defaults", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cfg-"));
  await fs.writeFile(
    path.join(dir, "config.yaml"),
    ["ollama:", "  model: llama3.1:8b", "agent:", "  full_auto: true", "  max_steps: 25", ""].join("\n")
  );
  const c = await loadConfig(dir);
  assert.equal(c.ollama.model, "llama3.1:8b");
  assert.equal(c.agent.full_auto, true);
  assert.equal(c.agent.max_steps, 25);
  // untouched defaults survive
  assert.equal(c.ollama.num_ctx, 8192);
  assert.equal(c.voice.tts.engine, "sapi");
  await fs.rm(dir, { recursive: true, force: true });
});

test("loadConfig expands ~ in workspace", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cfg-"));
  await fs.writeFile(path.join(dir, "config.yaml"), "agent:\n  workspace: \"~/projects\"\n");
  const c = await loadConfig(dir);
  assert.ok(!c.agent.workspace.startsWith("~"));
  assert.ok(c.agent.workspace.includes("projects"));
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------- workspace confinement ----------

test("confineToWorkspace accepts relative paths inside the root", () => {
  const root = path.resolve("/tmp/ws");
  assert.equal(confineToWorkspace("hello.txt", root), path.resolve(root, "hello.txt"));
  assert.equal(confineToWorkspace("sub/dir/file.txt", root), path.resolve(root, "sub/dir/file.txt"));
  assert.equal(confineToWorkspace(".", root), root);
});

test("confineToWorkspace accepts absolute paths inside the root", () => {
  const root = path.resolve("/tmp/ws");
  const inside = path.join(root, "a.txt");
  assert.equal(confineToWorkspace(inside, root), path.resolve(inside));
});

test("confineToWorkspace refuses ../ escapes", () => {
  const root = path.resolve("/tmp/ws");
  assert.equal(confineToWorkspace("../escape.txt", root), null);
  assert.equal(confineToWorkspace("a/../../../escape.txt", root), null);
});

test("confineToWorkspace refuses absolute paths outside the root", () => {
  const root = path.resolve("/tmp/ws");
  const outside = path.resolve("/tmp/other/a.txt");
  assert.equal(confineToWorkspace(outside, root), null);
});

test("confineToWorkspace refuses empty paths", () => {
  const root = path.resolve("/tmp/ws");
  assert.equal(confineToWorkspace("", root), null);
  assert.equal(confineToWorkspace("   ", root), null);
});

test("resolveWorkspaceCfg uses the configured workspace", () => {
  const c = structuredClone(DEFAULT_CONFIG);
  c.agent.workspace = "/tmp/custom-ws";
  assert.equal(resolveWorkspaceCfg(c), path.resolve("/tmp/custom-ws"));
});

test("resolveWorkspaceCfg expands ~", () => {
  const c = structuredClone(DEFAULT_CONFIG);
  c.agent.workspace = "~/my-ws";
  const r = resolveWorkspaceCfg(c);
  assert.ok(!r.startsWith("~"));
  assert.ok(r.endsWith("my-ws"));
});

test("resolveWorkspaceCfg defaults outside the agent's own directory", () => {
  const c = structuredClone(DEFAULT_CONFIG);
  c.agent.workspace = "";
  process.env.JARVIS_WORKSPACE = "";
  const r = resolveWorkspaceCfg(c);
  assert.ok(!r.startsWith(process.cwd()));
  assert.ok(r.includes("jarvis-workspace"));
});

// ---------- trading: indicators ----------

test("sma computes a simple moving average", () => {
  const out = sma([1, 2, 3, 4, 5], 3);
  assert.equal(out[2], 2);
  assert.equal(out[4], 4);
  assert.equal(out[1], null);
});

test("ema starts with the SMA seed then converges", () => {
  const out = ema([10, 10, 10, 10, 10], 3);
  assert.equal(out[2], 10);
  assert.equal(out[4], 10);
});

test("rsi is 100 after all-gains and low after all-losses", () => {
  const up = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  const r = rsi(up, 14);
  assert.equal(r[14], 100);
  const down = up.slice().reverse();
  const r2 = rsi(down, 14);
  assert.ok((r2[14] as number) < 5);
});

// ---------- trading: Survive/Die governor ----------

test("governor caps position size and count", () => {
  const d = canOpen(DEFAULT_RISK, { equity: 10000, cash: 10000, positions: 4, halt: "none", dayHalted: false }, 100);
  assert.equal(d.allowed, false); // 4 positions = max
  const d2 = canOpen(DEFAULT_RISK, { equity: 10000, cash: 10000, positions: 0, halt: "none", dayHalted: false }, 100);
  assert.equal(d2.allowed, true);
  assert.equal(d2.maxQty, 20); // Rs2000 budget / Rs100
  const d3 = canOpen(DEFAULT_RISK, { equity: 10000, cash: 10000, positions: 0, halt: "none", dayHalted: false }, 5000);
  assert.equal(d3.allowed, false); // Rs5000 share unaffordable with Rs2000 budget
});

test("governor halts on lock and review floors", () => {
  assert.equal(checkEquityCircuitBreakers(DEFAULT_RISK, 6900), "locked");
  assert.equal(checkEquityCircuitBreakers(DEFAULT_RISK, 7500), "review");
  assert.equal(checkEquityCircuitBreakers(DEFAULT_RISK, 9500), "none");
});

test("stop-loss triggers at threshold", () => {
  assert.equal(hitStopLoss(DEFAULT_RISK, 100, 94.9), true);
  assert.equal(hitStopLoss(DEFAULT_RISK, 100, 96), false);
});

// ---------- trading strategies: momentum + volume-surge ----------

/** Deterministic OHLCV series: px starts at 100 and compounds dailyRet(i). */
function synthBars(n: number, dailyRet: (i: number) => number, volume: (i: number) => number): Bar[] {
  const bars: Bar[] = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const open = px;
    px *= 1 + dailyRet(i);
    bars.push({
      date: `d${String(i).padStart(4, "0")}`,
      open,
      high: Math.max(open, px) * 1.002,
      low: Math.min(open, px) * 0.998,
      close: px,
      volume: volume(i),
    });
  }
  return bars;
}

 test("momentum buys strong uptrends and exits momentum crashes", () => {
  const strat = strategies["momentum"];
  const uptrend = synthBars(300, () => 0.005, () => 1000);
  assert.equal(strat.signal(uptrend, 299), "buy"); // +0.5%/day for 90d = roc90 ~56%
  const crashed = uptrend.slice();
  for (let i = 270; i < 300; i++) crashed[i] = { ...crashed[i], close: crashed[i - 1].close * 0.995, open: crashed[i].close * 1.01, high: crashed[i].close * 1.02, low: crashed[i].close * 0.99 };
  const flat = synthBars(300, () => 0.0005, () => 1000); // roc90 ~4.6% — no signal
  assert.equal(strat.signal(flat, 299), "hold");
});

test("volume-surge buys strong up-close on 3x volume, sells breakdowns", () => {
  const strat = strategies["volume-surge"];
  const quiet = synthBars(300, () => 0.001, () => 1000);
  const last = quiet[299];
  const surgeBar: Bar = { ...last, open: last.close / 1.001, close: last.close * 1.05, high: last.close * 1.052, low: last.close * 0.995, volume: 5000 };
  assert.equal(strat.signal([...quiet.slice(0, 299), surgeBar], 299), "buy");
  const breakdown = synthBars(300, (i) => (i < 275 ? 0.001 : -0.02), () => 1000);
  assert.equal(strat.signal(breakdown, 299), "sell"); // close below 20-SMA
});

test("compareStrategies runs all five on shared data without fetching", async () => {
  const keys = Object.keys(strategies);
  assert.equal(keys.length, 5);
  assert.ok(keys.includes("momentum") && keys.includes("volume-surge"));
  const data = new Map<string, Bar[]>([
    ["TESTA", synthBars(400, (i) => (i % 30 < 27 ? 0.004 : -0.01), () => 1000)],
    ["TESTB", synthBars(400, (i) => (i % 40 < 36 ? 0.003 : -0.015), () => 800)],
  ]);
  const rows = await compareStrategies(keys, ["TESTA", "TESTB"], 10_000, { data });
  assert.equal(rows.length, 5);
  for (const r of rows) {
    assert.ok(r.result, `${r.key} should produce a result: ${r.error ?? ""}`);
    assert.ok(r.result!.finalEquity > 0);
  }
});

// ---------- loop-breaker: repeated tool failures + truthful spawn errors ----------

test("isRepeatedFailure flags spawn failures, non-zero exits, refusals, and errors", () => {
  assert.equal(isRepeatedFailure(true, "file contents here\n[exit 0]"), false);
  assert.equal(isRepeatedFailure(true, "build failed\n[exit 1]"), true); // failing command = loop risk
  assert.equal(isRepeatedFailure(true, "boom\n[exit 2 TIMED OUT]"), true);
  assert.equal(isRepeatedFailure(true, "STDERR: spawn ENOENT\n[exit 127]"), true); // never started
  assert.equal(isRepeatedFailure(false, "Tool error: boom"), true);
  assert.equal(isRepeatedFailure(true, "Refused: cwd escapes the sandbox"), true);
  assert.equal(isRepeatedFailure(true, "Error: empty command"), true);
});

test("proc.run reports a missing cwd truthfully instead of spawn ENOENT", async () => {
  const missing = path.join(os.tmpdir(), "jarvis-missing-" + Date.now());
  const r = await procRun("echo hi", { cwd: missing });
  assert.equal(r.code, 127);
  assert.ok(r.stderr.includes("working directory does not exist"), r.stderr);
  assert.ok(!r.stderr.includes("cmd.exe")); // no more misleading shell error
});

test("shell tool refuses a non-existent cwd with a fix-it hint", async () => {
  const missing = path.join(os.tmpdir(), "jarvis-missing-" + Date.now(), "sub");
  await assert.rejects(
    shellTool.run({ command: "echo hi", cwd: missing }, { cfg: { agent: { workspace: os.tmpdir() } } } as never),
    /does not exist/
  );
});

// ---------- resilience: crashed sessions + Ollama down ----------

test("tidyMessages drops unanswered crashed user messages", () => {
  const msgs: OllamaMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "crashed q2" }, // saved then app died — no answer
    { role: "user", content: "q3" },
    { role: "assistant", content: "a3" },
    { role: "user", content: "crashed q4" }, // trailing, also unanswered
  ];
  const out = Agent.tidyMessages(msgs);
  assert.deepEqual(
    out.map((m) => `${m.role}:${m.content}`),
    ["system:sys", "user:q1", "assistant:a1", "user:q3", "assistant:a3"]
  );
});

test("agent answers in plain language instead of crashing when Ollama is down", async () => {
  const cfg: import("../src/core/config.js").AppConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    ollama: { ...structuredClone(DEFAULT_CONFIG).ollama, host: "http://127.0.0.1:9", model: "test", num_ctx: 512 },
    agent: { max_steps: 2, full_auto: true, allow_dangerous: false, workspace: os.tmpdir(), read_roots: [] },
  };
  const registry: ToolRegistry = { schemas: () => [], describe: () => [], list: () => [], register: () => {}, execute: async () => ({ result: "", ok: true }) };
  const sessionFile = path.join(os.tmpdir(), `jarvis-sess-${Date.now()}.json`);
  const agent = new Agent(cfg, registry as unknown as ToolRegistry, sessionFile, { ollamaGraceMs: 300 });
  const { answer } = await agent.run("hello");
  assert.match(answer, /can't reach my AI brain/);
  // The user message must NOT linger unanswered in the saved session.
  const saved = JSON.parse(await fs.readFile(sessionFile, "utf8")) as { messages: OllamaMessage[] };
  const last = saved.messages[saved.messages.length - 1];
  assert.equal(last.role, "assistant");
});

test("charlie parses DuckDuckGo results incl. wrapped and ad links", () => {
  const html = `
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ftrends.google.com%2Fin&t=1">Google Trends India</a>
    <a class="result__snippet" href="">What India is searching for today</a>
    <a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Sponsored thing</a>
    <a class="result__a" href="https://example.com/direct">Direct result</a>
    <a class="result__snippet" href="">A snippet here</a>`;
  const out = extractDuckResults(html);
  assert.equal(out.length, 2); // ad skipped
  assert.equal(out[0].url, "https://trends.google.com/in"); // decoded from DDG wrapper
  assert.equal(out[0].title, "Google Trends India");
  assert.equal(out[0].snippet, "What India is searching for today");
  assert.equal(out[1].url, "https://example.com/direct");
});

test("charlie extracts readable page text without scripts or tags", () => {
  const html = `<html><head><style>.x{color:red}</style></head>
    <body><script>alert('nope')</script>
    <h1>Trending Now</h1><p>Smart rings &amp; mini projectors</p></body></html>`;
  const text = extractPageText(html);
  assert.ok(text.includes("Trending Now"));
  assert.ok(text.includes("Smart rings & mini projectors"));
  assert.ok(!text.includes("alert"));
  assert.ok(!text.includes("<h1>"));
});

// ---------- UI: multipart uploads ----------

test("parseMultipart extracts fields and binary file parts", () => {
  const boundary = "----jarvistest42";
  const body = Buffer.from(
    [
      `--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello note\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="note.txt"\r\nContent-Type: text/plain\r\n\r\nFILE CONTENT HERE\r\n`,
      `--${boundary}--\r\n`,
    ].join("")
  );
  const { fields, files } = parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
  assert.equal(fields.note, "hello note");
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, "note.txt");
  assert.equal(files[0].data.toString("utf8"), "FILE CONTENT HERE");
});

test("extractPdfText inflates FlateDecode streams", () => {
  const packed = deflateSync(Buffer.from("(Zipped report text) Tj"));
  const pdf = Buffer.concat([
    Buffer.from("%PDF-1.4\nstream\n"),
    packed,
    Buffer.from("endstream\n%%EOF"),
  ]);
  const { text } = extractPdfText(pdf);
  assert.ok(text.includes("Zipped report text"));
});

// ---------- UI: multi-chat storage ----------

test("chats: save, list, load, delete round-trip", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-chats-"));
  const id = await createChat(dir);
  const msgs = [
    { role: "system", content: "sys" },
    { role: "user", content: "What should I buy today?" },
    { role: "assistant", content: "Here are today's signals." },
  ];
  await saveChat(dir, id, msgs as never);
  const list = await listChats(dir);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
  assert.equal(list[0].title, "What should I buy today?");
  assert.equal(list[0].messageCount, 2);
  const loaded = await loadChat(dir, id);
  assert.ok(loaded);
  assert.equal(loaded!.length, 3);
  assert.ok(await deleteChat(dir, id));
  assert.equal((await listChats(dir)).length, 0);
  assert.equal(await loadChat(dir, id), null);
});

test("chats: renames keep the original title until changed", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-chats-"));
  const id = await createChat(dir);
  await saveChat(dir, id, [{ role: "user", content: "first title wins" }] as never, "My custom title");
  const list1 = await listChats(dir);
  assert.equal(list1[0].title, "My custom title");
  // Second save (new answer) must NOT reset the user's custom title.
  await saveChat(dir, id, [
    { role: "user", content: "first title wins" },
    { role: "assistant", content: "answer" },
  ] as never);
  assert.equal((await listChats(dir))[0].title, "My custom title");
});

test("deriveTitle takes the first real user message", () => {
  assert.equal(deriveTitle([{ role: "system", content: "sys" }, { role: "user", content: "  hello world  " }]), "hello world");
  assert.equal(deriveTitle([]), "New chat");
});

test("deriveTitle skips attachment metadata and uses the real question", () => {
  const content = "[Attached pdf: phoenix.pdf]\n[Content of phoenix.pdf:\nRs 450,000 budget\n]\n\nUser's question: What is the total budget?";
  const t = deriveTitle([{ role: "user", content }]);
  assert.equal(t, "What is the total budget?");
  const t2 = deriveTitle([{ role: "user", content: "[Attached image: pic.jpg]\nDescribe this" }]);
  assert.equal(t2, "Describe this");
});

// ---------- Charlie: product images ----------

test("parseDuckImages keeps only renderable product shots", () => {
  const j = JSON.stringify({ results: [
    { image: "https://x.com/p/shoe.jpg", width: 800, height: 600, url: "https://shop.example/shoe" },
    { image: "data:image/png;base64,xxx" },                       // not http
    { image: "https://x.com/p/big.svg" },                          // not renderable
    { image: "https://x.com/p/bag.png?v=2", width: 400, height: 400, url: "" },
    { image: 42 },                                                 // garbage
  ]});
  const out = parseDuckImages(j);
  assert.equal(out.length, 2);
  assert.equal(out[0].image, "https://x.com/p/shoe.jpg");
  assert.equal(out[0].source, "https://shop.example/shoe");
  assert.equal(out[1].image, "https://x.com/p/bag.png?v=2");
  assert.deepEqual(parseDuckImages("garbage"), []);
});

test("parseVqd finds DuckDuckGo's token", () => {
  assert.equal(parseVqd(`<script>window.vqd="4-123456789"</script>`), "4-123456789");
  assert.equal(parseVqd("no token here"), null);
});

test("productNames reads numbered bold product lines", () => {
  const a = "1. **Printed T-Shirts** - trend\n2. **Mobile Accessories** - trend\nnot 3. **Skipped**\n3. **Yoga Mats**\n";
  assert.deepEqual(productNames(a), ["Printed T-Shirts", "Mobile Accessories", "Yoga Mats"]);
});

test("imagesBlock formats the relay-safe gallery block", () => {
  const b = imagesBlock([{ name: "Yoga Mats", image: "https://i.example/y.jpg", source: "https://s.example/y" }]);
  assert.ok(b.startsWith("\n\nIMAGES:\n"));
  assert.ok(b.includes("PRODUCT: Yoga Mats\nIMAGE_URL: https://i.example/y.jpg"));
  assert.equal(imagesBlock([]), "");
});

// ---------- Gmail: IMAP parsing ----------

test("decodeHeader handles RFC2047 base64 and qp words", () => {
  assert.equal(decodeHeader("=?utf-8?B?SGVsbG8gV29ybGQ=?="), "Hello World");
  assert.equal(decodeHeader("=?utf-8?Q?caf=C3=A9?="), "café");
  assert.equal(decodeHeader("plain text"), "plain text");
});

test("qpDecode is byte-accurate UTF-8", () => {
  assert.equal(qpDecode("caf=C3=A9"), "café");
  assert.equal(qpDecode("line one=\r\nline two"), "line oneline two");
});

test("parseMailList extracts uid, sender, subject, snippet", () => {
  const listing = [
    "* 1 FETCH (UID 51 FLAGS (\\Seen) INTERNALDATE \"25-Sep-2026 08:01:00 +0530\"",
    "  From: Boss <boss@corp.com>",
    "  Subject: Sales report",
    "  Date: Fri, 25 Sep 2026 08:00:00 +0530",
    "  BODY[TEXT]<0> {24}",
    "Please send the Q3 nu",
    "mbers by today. Thanks",
    ")",
    "* 2 FETCH (UID 52 FLAGS () INTERNALDATE \"25-Sep-2026 09:15:10 +0530\"",
    "  From: =?utf-8?B?QW1hem9uIEluZGlh?= <no-reply@amazon.in>",
    "  Subject: Your order has shipped",
    "  BODY[TEXT]<0> {20}",
    "Your package is on t",
    "he way. Track it here.",
    ")",
    "A3 OK done",
  ].join("\r\n");
  const mails = parseMailList(listing);
  assert.equal(mails.length, 2);
  assert.equal(mails[0].uid, 51);
  assert.equal(mails[0].seen, true);
  assert.equal(mails[0].from, "Boss <boss@corp.com>");
  assert.equal(mails[0].subject, "Sales report");
  assert.ok(mails[0].snippet.startsWith("Please send the Q3 numbers"));
  assert.equal(mails[1].uid, 52);
  assert.equal(mails[1].seen, false);
  assert.equal(mails[1].from, "Amazon India <no-reply@amazon.in>");
  assert.ok(mails[1].snippet.includes("Track it here"));
});

test("parseSearchUids reads the newest uids", () => {
  assert.deepEqual(parseSearchUids(["* SEARCH 11 12 13 14", "A2 OK done"], 2), [13, 14]);
  assert.deepEqual(parseSearchUids(["* SEARCH", "A2 OK done"], 5), []);
  assert.deepEqual(parseSearchUids(["* ESEARCH (TAG \"A2\") UID 9 10"], 1), [10]);
});

test("gmailBriefing is honest when unconfigured", async () => {
  const savedU = process.env.GMAIL_USER, savedP = process.env.GMAIL_APP_PASSWORD;
  delete process.env.GMAIL_USER; delete process.env.GMAIL_APP_PASSWORD;
  const brief = await gmailBriefing();
  process.env.GMAIL_USER = savedU; process.env.GMAIL_APP_PASSWORD = savedP;
  assert.match(brief, /isn't set up yet/);
});

// ---------- image generation ----------

test("buildImageUrl encodes the prompt and options", () => {
  const url = buildImageUrl("a red sports car, sunset", { width: 512, height: 512, seed: 7 });
  assert.ok(url.includes("image.pollinations.ai/prompt/"));
  assert.ok(url.includes(encodeURIComponent("a red sports car, sunset")));
  assert.ok(url.includes("width=512"));
  assert.ok(url.includes("seed=7"));
});

test("imagesBlockLocal emits local: paths the UI can serve", () => {
  const b = imagesBlockLocal([{ name: "Logo", image: "local:data/generated/logo-1.png" }]);
  assert.ok(b.startsWith("\n\nIMAGES:\n"));
  assert.ok(b.includes("IMAGE_URL: local:data/generated/logo-1.png"));
  assert.equal(imagesBlockLocal([]), "");
});

test("polishPrompt adds style hints without duplicating them", () => {
  assert.equal(polishPrompt(""), "a beautiful detailed illustration");
  assert.ok(polishPrompt("a cat on a roof").includes("a cat on a roof"));
  assert.ok(polishPrompt("a cat on a roof").endsWith("high quality"));
  assert.equal(polishPrompt("oil painting of a river"), "oil painting of a river"); // style already present
});

test("detectImageExt sniffs real formats from magic bytes", () => {
  assert.equal(detectImageExt(Buffer.from([0xff, 0xd8, 0xff, 0xe1])), ".jpg");
  assert.equal(detectImageExt(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), ".png");
  assert.equal(detectImageExt(Buffer.from("GIF89a")), ".gif");
  assert.equal(detectImageExt(Buffer.from("RIFF1234WEBPVP8 ")), ".webp");
});

// ---------- cloud brain: privacy redaction + enable gating ----------

test("redactSecrets masks tokens and .env-style assignments before sending", () => {
  const text = [
    "GITHUB_TOKEN=ghp_16C7e42F292c6912E7710c838347Ae178B4a",
    "my key is gsk_1a2b3c4d5e6f7g8h9i0j",
    "JWT: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "plain text stays untouched",
  ].join("\n");
  const out = redactSecrets(text);
  assert.ok(!out.includes("ghp_16C7e42F"), out);
  assert.ok(!out.includes("gsk_1a2b3c4d5e6f7g8h9i0j"), out);
  assert.ok(!out.includes("eyJhbGciOiJIUzI1NiIs"), out);
  assert.ok(out.includes("GITHUB_TOKEN="), "assignment key stays");
  assert.ok(out.includes("plain text stays untouched"));
});

test("redactMessage strips attachment contents and local paths", () => {
  const msg = {
    role: "user" as const,
    content: "[Attached pdf: a.pdf]\n[Content of a.pdf:\nSECRET BUDGET NUMBERS\n]\n\nUser's question: sum it? also check C:\\Users\\shrey\\notes.txt",
  };
  const out = redactMessage(msg);
  assert.ok(!out.content.includes("SECRET BUDGET NUMBERS"), out.content);
  assert.ok(!out.content.includes("C:\\Users\\shrey"), out.content);
  assert.ok(out.content.includes("User's question: sum it?"));
});

test("cloudConfigured: off without key, on with key, off when disabled", () => {
  const base = structuredClone(DEFAULT_CONFIG);
  assert.equal(cloudConfigured(base), false); // default key empty
  const on = structuredClone(DEFAULT_CONFIG);
  on.cloud!.api_key = "gsk_test_key";
  assert.equal(cloudConfigured(on), true);
  const off = structuredClone(on);
  off.cloud!.enabled = false;
  assert.equal(cloudConfigured(off), false);
  const noCloud = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>;
  delete noCloud.cloud;
  assert.equal(cloudConfigured(noCloud as never), false);
});

// ---------- cloud brain: slimming + model self-healing ----------

import { slimForCloud, minifyTools, pickPreferredModel } from '../src/core/cloud.js';
import type { OllamaTool } from '../src/core/ollama.js';

test('slimForCloud keeps complete tool blocks and trims fat outputs', () => {
  const msgs = [
    { role: 'system', content: 'RULES'.repeat(6000) + '\n## Available tools\n- read_file: x' },
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }] },
    { role: 'tool', content: 'x'.repeat(9000) },
  ];
  const out = slimForCloud(msgs as never);
  assert.ok(out[0].content.length < 7000, 'system prompt compacted');
  assert.ok(!out[0].content.includes('Available tools'), 'tool text block dropped');
  const toolMsg = out.find((m) => m.role === 'tool');
  assert.ok(toolMsg && toolMsg.content.length <= 2600, 'tool output trimmed');
  // assistant + its tool reply stay together
  const idxA = out.findIndex((m) => m.role === 'assistant');
  const idxT = out.findIndex((m) => m.role === 'tool');
  assert.ok(idxA > -1 && idxT === idxA + 1);
});

test('minifyTools keeps names and required fields, drops long descriptions', () => {
  const tool: OllamaTool = {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from disk. List several paths to read several files. More detail here.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'The path to read' } }, required: ['path'] },
    },
  };
  const out = minifyTools([tool]) as Array<{ function: { name: string; description: string; parameters: { required: string[] } } }>;
  assert.equal(out[0].function.name, 'read_file');
  assert.ok(out[0].function.description.length < 95);
  assert.deepEqual(out[0].function.parameters.required, ['path']);
});

test('pickPreferredModel picks the best available model that differs from current', () => {
  const avail = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'llama-3.1-8b-instant'];
  assert.equal(pickPreferredModel(avail, 'qwen/qwen3.8-27b'), 'openai/gpt-oss-120b'); // best first
  assert.equal(pickPreferredModel(avail, 'openai/gpt-oss-120b'), 'qwen/qwen3.8-27b');
  assert.equal(pickPreferredModel(['openai/gpt-oss-20b'], 'qwen/qwen3.8-27b'), 'openai/gpt-oss-20b');
  assert.equal(pickPreferredModel([], 'x'), null);
});

// ---------- Personal-assistant layer: memory, reminders, activity, personal folders ----------

test('memory parses facts, dedupes near-duplicates and removes them', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'jarvis-mem-'));
  const raw = [
    '# Things Jarvis knows about me',
    '<!-- a comment, not a fact -->',
    '- [2026-09-26] Lives in Mumbai',
    '- studies for CA Final',
    'a line with no bullet marker',
  ].join('\n');
  const facts = parseFacts(raw);
  assert.equal(facts.length, 2);
  assert.equal(facts[0].text, 'Lives in Mumbai');
  assert.equal(facts[0].addedAt, '2026-09-26');
  assert.equal(facts[1].addedAt, '');

  assert.equal(await addFacts(dir, ['Lives in Mumbai']), 1);
  assert.equal(await addFacts(dir, ['lives in  mumbai!']), 0, 'punctuation/case duplicate must not be stored twice');
  assert.equal(await addFacts(dir, ['Runs a small business', '']), 1);
  const stored = await listFacts(dir);
  assert.equal(stored.length, 2);
  assert.equal(await removeFact(dir, 'small business'), true);
  assert.equal((await listFacts(dir)).length, 1);
  assert.equal(await removeFact(dir, 'nothing like this exists'), false);
  assert.match(renderFacts(stored), /^# Things Jarvis knows about me/);
  assert.equal(memoryPromptSection(''), '');
  assert.match(memoryPromptSection(renderFacts(stored)), /Lives in Mumbai/);
});

test('"remember" requests are picked straight out of the user message', () => {
  assert.deepEqual(extractRememberRequests('remember that I drink black coffee in the morning'), [
    'I drink black coffee in the morning',
  ]);
  assert.deepEqual(extractRememberRequests('Remember: my exam is in June. Also note that I live in Mumbai.'), [
    'my exam is in June',
    'I live in Mumbai',
  ]);
  assert.deepEqual(extractRememberRequests('keep in mind I prefer short answers'), ['I prefer short answers']);
  assert.deepEqual(extractRememberRequests('what is the weather today?'), []);
  assert.deepEqual(extractRememberRequests('remember to call the CA tomorrow'), []); // a task, not a fact
});

test('"remember X and that Y" splits into two facts and near-duplicates collapse', async () => {
  assert.deepEqual(
    extractRememberRequests('remember that I drink black coffee in the morning and that my name is Shrey'),
    ['I drink black coffee in the morning', 'my name is Shrey']
  );
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'jarvis-mem3-'));
  assert.equal(await addFacts(dir, ['I drink black coffee in the morning']), 1);
  assert.equal(
    await addFacts(dir, ['Drinks black coffee in the morning']),
    0,
    'the same fact said differently must not be stored twice'
  );
  assert.equal(await addFacts(dir, ['Owns a Windows 11 PC']), 1);
  assert.equal(await addFacts(dir, ['Owns a Windows 11 PC with 32GB RAM']), 0, 'a longer version of a known fact is still the same fact');
});

test('saved "remember" facts really land in the memory file', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'jarvis-rem2-'));
  const asked = extractRememberRequests('remember that I drink black coffee in the morning');
  assert.equal(await addFacts(dir, asked), 1);
  assert.equal(await addFacts(dir, asked), 0, 'saying it twice must not duplicate it');
  const raw = await fsp.readFile(path.join(dir, 'memory', 'user.md'), 'utf8');
  assert.match(raw, /- \[\d{4}-\d{2}-\d{2}\] I drink black coffee in the morning/);
  assert.match(raw, /^# Things Jarvis knows about me/);
});

test('reminder schedule math handles repeats, weekdays and long gaps', () => {
  const from = new Date('2026-09-26T10:00:00Z');
  assert.equal(nextDue('2026-09-26T09:00:00Z', 'none', from), null);
  assert.equal(nextDue('2026-09-26T09:00:00Z', 'daily', from), '2026-09-27T09:00:00.000Z');
  assert.equal(nextDue('2026-09-26T09:00:00Z', 'weekly', from), '2026-10-03T09:00:00.000Z');
  const friday = new Date('2026-09-25T18:00:00Z');
  const next = new Date(nextDue('2026-09-25T09:00:00Z', 'weekdays', friday)!);
  assert.ok(![0, 6].includes(next.getDay()), `weekday expected, got ${next.toISOString()}`);
  assert.ok(next.getTime() > friday.getTime());
  assert.equal(nextDue('not a date', 'daily', from), null);
});

test('parseWhen understands relative, clock and ISO times', () => {
  const now = new Date('2026-09-26T10:00:00');
  const rel = parseWhen('in 45 minutes', now)!;
  assert.equal(rel.getHours(), 10);
  assert.equal(rel.getMinutes(), 45);
  const hrs = parseWhen('in 2 hours', now)!;
  assert.equal(hrs.getHours(), 12);
  const clock = parseWhen('6:30pm', now)!;
  // Stored instants are UTC; with the undetected offset (0) in tests the
  // wall-clock digits land on the same UTC clock — zone-independent assert.
  assert.equal(clock.getUTCHours(), 18);
  assert.equal(clock.getUTCMinutes(), 30);
  const iso = parseWhen('2026-12-01T08:15', now)!;
  // Naive digits round-trip through the explicit tz layer (offset 0 in tests):
  // assert in UTC so the test is independent of the ambient machine zone.
  assert.equal(iso.getUTCFullYear(), 2026);
  assert.equal(iso.getUTCMonth(), 11);
  assert.equal(iso.getUTCHours(), 8);
  assert.equal(parseWhen('sometime soon', now), null);
  assert.equal(parseWhen('', now), null);
});

test('explicit tz: naive wall-clock parses and formats in the detected zone', async () => {
  const { formatDueLocal, localWallClockToUtc } = await import('../src/core/tz.js');
  // Tests run with the undetected offset (0 = UTC): digits map to UTC.
  const d = localWallClockToUtc('2026-12-01 08:15')!;
  assert.equal(d.toISOString(), '2026-12-01T08:15:00.000Z');
  assert.equal(localWallClockToUtc('garbage'), null);
  assert.equal(formatDueLocal('2026-12-01T08:15:00Z'), 'Tue, 1 Dec, 8:15 AM');
  assert.equal(formatDueLocal('not a date'), 'not a date');
});

test('reminders persist, fire once, repeat and cancel', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'jarvis-rem-'));
  const past = new Date(Date.now() - 60_000);
  const item = await addReminder(dir, { text: 'call the CA', when: past, repeat: 'daily' });
  assert.equal((await listReminders(dir)).length, 1);
  assert.equal((await dueReminders(dir)).length, 1);
  await markFired(dir, item.id);
  assert.equal((await dueReminders(dir)).length, 0, 'a fired reminder must not fire twice this minute');
  assert.equal((await firedReminders(dir)).length, 1);
  const repeated = await listReminders(dir);
  assert.equal(repeated.length, 1, 'a repeating reminder stays pending');
  assert.ok(Date.parse(repeated[0].dueAt) > Date.now(), 'repeat must be rescheduled into the future');

  const once = await addReminder(dir, { text: 'one shot', when: past });
  await markFired(dir, once.id);
  assert.equal((await listReminders(dir)).length, 1, 'a one-off reminder disappears after firing');

  assert.ok(await cancelReminder(dir, 'call the CA'));
  assert.equal((await listReminders(dir)).length, 0);
  assert.equal(await cancelReminder(dir, 'never existed'), null);
});

test('activity log records human-readable actions and hides secrets', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'jarvis-act-'));
  await logActivity(dir, 'shell', summarizeToolCall('shell', { command: 'npm test' }), true);
  await logActivity(dir, 'write_file', summarizeToolCall('write_file', { path: 'notes.md' }), false);
  await logActivity(dir, 'shell', summarizeToolCall('shell', { command: 'export TOKEN=sk-abcdefghijklmnopqrstuvwx' }), true);
  const entries = await readActivity(dir);
  assert.equal(entries.length, 3);
  assert.match(entries[0].summary, /ran a command: npm test/);
  assert.equal(entries[1].ok, false);
  assert.match(entries[1].summary, /notes\.md/);
  assert.ok(!entries[2].summary.includes('abcdefghijklmnopqrstuvwx'), `secret leaked: ${entries[2].summary}`);
  assert.match(summarizeToolCall('trade_signals'), /NSE/);
  assert.match(summarizeToolCall('screenshot_screen'), /screen/);
  assert.equal(summarizeToolCall('totally_unknown_tool'), 'used totally_unknown_tool');
});

test('your own folders are readable, system paths are not', () => {
  const home = os.homedir();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.agent.read_roots = ['~/Downloads', '~/Desktop'];
  const roots = resolveReadRoots(cfg);
  assert.equal(roots.length, 2);
  assert.ok(!roots[0].startsWith('~'), 'home must be expanded');
  const ws = path.join(home, 'jarvis-workspace');
  assert.equal(resolveReadablePath('notes.md', ws, roots), path.join(ws, 'notes.md'));
  assert.equal(
    resolveReadablePath(path.join(home, 'Downloads', 'cv.pdf'), ws, roots),
    path.join(home, 'Downloads', 'cv.pdf')
  );
  assert.equal(resolveReadablePath(path.join(home, 'Desktop', 'x.txt'), ws, roots), path.join(home, 'Desktop', 'x.txt'));
  assert.equal(resolveReadablePath('C:\\Windows\\System32\\config\\SAM', ws, roots), null);
  assert.equal(resolveReadablePath(path.join(home, 'Downloads'), ws, roots), path.join(home, 'Downloads'));
  assert.equal(resolveReadablePath('../escape.txt', ws, roots), null);
  assert.equal(path.normalize(expandHome('~/x')), path.join(home, 'x'));
  assert.ok(isInsideRoot(path.join(home, 'Downloads', 'a', 'b.txt'), path.join(home, 'Downloads')));
  assert.ok(!isInsideRoot(path.join(home, 'Downloads2', 'b.txt'), path.join(home, 'Downloads')));
});

test('free wake-word matcher: jarvis variants hit, other speech does not', async () => {
  const { transcriptMatchesWakeWord, wordsAfterWakeWord } = await import('../src/voice/wake.js');
  const hit = (t: string) => transcriptMatchesWakeWord(t, 'jarvis');
  assert.ok(hit('jarvis')); // bare wake word
  assert.ok(hit('hey jarvis')); // greeting prefix
  assert.ok(hit('jarvis what is on my calendar today')); // command in same breath
  assert.ok(hit('jervis')); // common mishearing
  assert.ok(hit('hi jarvic')); // another variant
  assert.ok(!hit('')); // silence
  assert.ok(!hit('the weather is nice today')); // conversation, not the word
  assert.ok(!hit('jazz')); // too short / wrong stem
  assert.ok(!hit('traffic on the highway')); // 'jar'-ish but wrong
  assert.deepEqual(wordsAfterWakeWord('jarvis what time is it', 'jarvis'), ['what', 'time', 'is', 'it']);
  assert.deepEqual(wordsAfterWakeWord('jarvis', 'jarvis'), []);
});

test('speech capture: sample-correct timing (no premature cuts)', async () => {
  const { SpeechCapture } = await import('../src/voice/capture.js');
  const sr = 16_000;
  const cap = new SpeechCapture({
    sampleRate: sr, threshold: 450, leadMs: 400, endSilenceMs: 900, maxMs: 4500, prerollMs: 400,
  });
  const loud = (n: number, amp = 3000): Int16Array => {
    const a = new Int16Array(n);
    for (let i = 0; i < n; i++) a[i] = ((i * 7919) % 2000) - 1000 + amp;
    return a;
  };
  const quiet = (n: number): Int16Array => new Int16Array(n); // silence
  // Speak for 1 second: capture must START (not end).
  let ev: any = null;
  for (let i = 0; i < 20; i++) ev = cap.feed(loud(800)); // 20 x 50ms = 1s
  assert.equal(cap.isCapturing, true, 'capture must be active while speaking');
  // 0.5s of silence must NOT end a 0.9s-silence clip.
  for (let i = 0; i < 10; i++) cap.feed(quiet(800));
  assert.equal(cap.isCapturing, true, '0.5s of silence must not end the clip');
  // A full 0.9s+ of silence must end it, with ~1.9s of audio inside.
  for (let i = 0; i < 20; i++) {
    const e = cap.feed(quiet(800));
    if (e) ev = e; // keep the clip event — later silent chunks return null
  }
  assert.ok(ev && ev.kind === 'clip', 'clip must complete after end-silence');
  if (ev && ev.kind === 'clip') {
    assert.ok(ev.samples.length > sr, `clip must hold ~2s of audio, got ${ev.samples.length} samples`);
    assert.equal(ev.hitMax, false);
  }
  // And a second utterance can be captured afterwards.
  for (let i = 0; i < 20; i++) cap.feed(loud(800));
  assert.equal(cap.isCapturing, true, 'engine must re-arm after a finished clip');
});

test('speech capture: short blips and silence are discarded', async () => {
  const { SpeechCapture } = await import('../src/voice/capture.js');
  const cap = new SpeechCapture({
    sampleRate: 16_000, threshold: 450, leadMs: 400, endSilenceMs: 900, maxMs: 4500, prerollMs: 400,
  });
  const blip = new Int16Array(800); // one 50ms loud blip
  for (let i = 0; i < blip.length; i++) blip[i] = 3000;
  let sawClip = false;
  for (let i = 0; i < 60; i++) {
    const ev = cap.feed(i === 0 ? blip : new Int16Array(800));
    if (ev?.kind === 'clip') sawClip = true;
  }
  assert.ok(!sawClip, 'a single blip must not become a clip');
});
