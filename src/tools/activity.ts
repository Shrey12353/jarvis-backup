import type { Tool, ToolContext } from "./types.js";
import { readActivity } from "../core/activity.js";

/** "What have you been doing?" — answered from the plain-language activity log. */
export const activityTools: Tool[] = [
  {
    name: "what_did_you_do",
    description:
      "List everything you actually did (each action, with the time), from the activity log. Use when the user asks what you did today / while they were away / what you've been up to.",
    safety: "auto",
    parameters: {
      type: "object",
      properties: {
        day: { type: "string", description: "today (default) | yesterday | a date like 2026-09-25" },
      },
    },
    async run(args, ctx: ToolContext) {
      const raw = String(args.day ?? "today").trim().toLowerCase();
      const target =
        raw === "today"
          ? new Date()
          : raw === "yesterday"
            ? new Date(Date.now() - 24 * 60 * 60 * 1000)
            : /^\d{4}-\d{2}-\d{2}$/.test(raw)
              ? new Date(raw + "T12:00:00")
              : null;
      if (!target || isNaN(target.getTime())) return `Error: I don't understand the day "${args.day}". Use today, yesterday or a date like 2026-09-25.`;
      const entries = await readActivity(ctx.cfg.paths.data, target.toISOString().slice(0, 10));
      if (!entries.length) return `Nothing recorded for ${target.toISOString().slice(0, 10)} yet.`;
      const lines = entries.map((e) => {
        const t = new Date(e.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
        return `${t} — ${e.summary}${e.ok ? "" : " (failed)"}`;
      });
      return `Actions recorded (${entries.length}) on ${target.toISOString().slice(0, 10)}:\n${lines.join("\n")}`;
    },
  },
];
