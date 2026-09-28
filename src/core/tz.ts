/**
 * Explicit local-timezone handling.
 *
 * On this PC Node resolves the "local" timezone to UTC (a Windows/Git-Bash
 * quirk), so `Date.toLocaleString()` and naive ISO parsing rendered reminder
 * times 5.5 hours off (IST). We detect the real offset from Windows once and
 * use it explicitly for: parsing wall-clock times the user/model gives us,
 * disambiguating naive ISO strings, and formatting due times for toasts.
 *
 * Storage stays correct-UTC ISO instants — this module only touches the
 * human-facing parse/format layer.
 */
import { runArgv } from "./proc.js";

/** Detected offset from UTC, in minutes (IST = +330). Defaults to 0. */
export let tzOffsetMinutes = 0;

/**
 * Detect the machine's real UTC offset once. Windows is authoritative via
 * PowerShell (Get-LocalTime returns a DateTime with the correct Offset);
 * on other platforms we trust the Node zone and read the offset directly.
 */
export async function detectTimezone(): Promise<number> {
  try {
    if (process.platform === "win32") {
      // argv spawn (no shell) — quoting a -Command string through cmd.exe
      // mangles the inner quotes and the offset regex never matches.
      const r = await runArgv([
        "powershell",
        "-NoProfile",
        "-Command",
        "(Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')",
      ], { timeoutMs: 15_000 });
      const m = /([+-]\d{2}):(\d{2})$/.exec(r.stdout.trim());
      if (m) {
        const sign = m[1].startsWith("-") ? -1 : 1;
        tzOffsetMinutes = sign * (Math.abs(Number(m[1])) * 60 + Number(m[2]));
      }
    } else {
      tzOffsetMinutes = -new Date().getTimezoneOffset();
    }
  } catch {
    tzOffsetMinutes = 0; // fall back to UTC behaviour, never crash
  }
  return tzOffsetMinutes;
}

function pad(n: number): string {
  return String(Math.abs(n)).padStart(2, "0");
}

function sign(mins: number): string {
  return mins < 0 ? "-" : "+";
}

/** Format a UTC instant in the user's real local time, e.g. "Mon, 28 Sep, 11:33 AM". */
export function formatDueLocal(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const local = new Date(d.getTime() + tzOffsetMinutes * 60_000);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const h24 = local.getUTCHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const ap = h24 < 12 ? "AM" : "PM";
  return `${days[local.getUTCDay()]}, ${local.getUTCDate()} ${months[local.getUTCMonth()]}, ${h12}:${pad(local.getUTCMinutes())} ${ap}`;
}

/**
 * Interpret a wall-clock date-time string in the user's real local zone.
 * Returns the correct UTC instant, or null if the string is not a valid
 * naive "YYYY-MM-DD[ HH:MM[:SS]]" date-time.
 */
export function localWallClockToUtc(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(se ?? 0));
  return new Date(asUtc - tzOffsetMinutes * 60_000);
}
