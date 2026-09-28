/**
 * Google Calendar — read-only access through the agent's signed-in browser
 * profile (the same one-time Google sign-in that Gmail uses). No API keys:
 * the persistent profile remembers the user, and writes stay out of scope so
 * the assistant can read the day but never edit it.
 */
import type { Tool } from "./types.js";

const CALENDAR_URL = "https://calendar.google.com/calendar/u/0/r/day";

/** True when the page is Google's login instead of the calendar. */
function isLoginPage(url: string): boolean {
  return /accounts\.google\.com|ServiceLogin|signin/i.test(url);
}

async function browserCalendarPage(): Promise<{ text: string; loginNeeded: boolean }> {
  const { openOnAgentProfile } = await import("./browser.js");
  const { DEFAULT_CONFIG } = await import("../core/config.js");
  const ctx = {
    cfg: { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, workspace: process.env.JARVIS_WORKSPACE || "" } },
  } as never;
  const p = await openOnAgentProfile(ctx, CALENDAR_URL);
  await p.waitForTimeout(4_000); // calendar renders slowly even when cached
  if (isLoginPage(p.url())) return { text: "", loginNeeded: true };
  const text = await p.evaluate(() => {
    // Event chips carry data-eventid; fall back to any time-prefixed text.
    const chips = Array.from(document.querySelectorAll("[data-eventid]")) as HTMLElement[];
    if (chips.length) {
      return chips
        .map((c) => c.innerText.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, 30)
        .join("\n");
    }
    const body = document.body?.innerText ?? "";
    return body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^\d{1,2}(:\d{2})?\s*(am|pm)/i.test(l))
      .slice(0, 30)
      .join("\n");
  });
  return { text: text.trim(), loginNeeded: false };
}

export const calendarTools: Tool[] = [
  {
    name: "calendar_today",
    description:
      "Read today's events from the user's Google Calendar (through the signed-in browser). Use for 'what's on today?', 'my next meeting', or the daily briefing. Read-only, safe. If a sign-in is needed it says exactly that.",
    safety: "auto",
    parameters: { type: "object", properties: {} },
    async run() {
      try {
        const { text, loginNeeded } = await browserCalendarPage();
        if (loginNeeded) {
          return [
            "Google Calendar needs the one-time sign-in: a browser window just opened at the Google login page.",
            "Sign in once (same account as Gmail), then ask again — you stay signed in.",
          ].join("\n");
        }
        if (!text) return "Your calendar for today looks empty (or Google's layout hid the events from me).";
        return `Today's calendar:\n${text}`;
      } catch (e) {
        return `Calendar error: ${e instanceof Error ? e.message : String(e)} — say 'set up my email' first if Google was never signed in.`;
      }
    },
  },
];
