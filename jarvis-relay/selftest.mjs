// Self-test for relay time logic (no network, no state).
import fs from "node:fs";

const src = fs.readFileSync(new URL("./relay.mjs", import.meta.url), "utf8");
// Extract everything up to the telegram section (pure helpers) into a module.
const head = src.slice(0, src.indexOf("// ---------- telegram ----------"));
const modSrc = head + "\nexport { parseWhen, nextDue, fmtDue, state };\n";
fs.writeFileSync(new URL("./_t.mjs", import.meta.url), modSrc);
const { parseWhen, nextDue, fmtDue, state } = await import(new URL("./_t.mjs", import.meta.url));

const now = new Date("2026-09-28T14:00:00"); // 2:00 PM local
let fails = 0;
const eq = (name, got, want) => {
  const ok = String(got) === String(want);
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${got}${ok ? "" : ` (want ${want})`}`);
};

const a = parseWhen("in 30 minutes", now);
eq("in 30 minutes hour", a.getHours(), 14);
eq("in 30 minutes minute", a.getMinutes(), 30);

const b = parseWhen("9:00am", now);
eq("9am rolls to tomorrow", b.getDate(), 29);
eq("9am hour", b.getHours(), 9);

const c = parseWhen("tomorrow 8pm", now);
eq("tomorrow 8pm date", c.getDate(), 29);
eq("tomorrow 8pm hour", c.getHours(), 20);

const d = parseWhen("2026-10-05 07:15", now);
eq("iso date hour", d.getHours(), 7);
eq("iso date day", d.getDate(), 5);

eq("fmt sample", fmtDue(new Date(2026, 8, 29, 15, 30).toISOString()), "Tue, 29 Sep, 3:30 PM");

const nd = nextDue(new Date(2026, 8, 28, 9, 0).toISOString(), "daily", now);
eq("daily next is tomorrow 9am", new Date(nd).getDate(), 29);

const wd = nextDue(new Date(2026, 8, 28, 9, 0).toISOString(), "weekdays", now); // Mon 28 Sep
eq("weekdays skips to Tue", new Date(wd).getDate(), 29);

console.log(fails ? `\n${fails} FAILURES` : "\nALL PASS");
process.exit(fails ? 1 : 0);
