import type { Tool, ToolContext } from "./types.js";
import {
  addReminder,
  cancelReminder,
  formatDue,
  listReminders,
  parseWhen,
  type Repeat,
} from "../core/reminders.js";
import { showNotification } from "../core/notify.js";

const REPEATS: Repeat[] = ["none", "daily", "weekdays", "weekly"];

/**
 * Reminder tools. The scheduler that actually fires them lives in the UI
 * server (a toast + a note in the chat), so reminders work whenever Jarvis is
 * running — including after a reboot, because the store is on disk.
 */
export const reminderTools: Tool[] = [
  {
    name: "remind_add",
    description:
      "Set a reminder. Give the exact date-time (compute it from today's date in the prompt; \"2026-09-27T18:00\" or \"in 45 minutes\"). It fires a Windows notification and appears in the Jarvis chat, even after a restart.",
    safety: "auto",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "What to remind the user about" },
        when: { type: "string", description: "Exact time: ISO like 2026-09-27T18:00, or \"in 45 minutes\", or \"18:00\"" },
        repeat: { type: "string", description: "none (default) | daily | weekdays | weekly" },
      },
      required: ["text", "when"],
    },
    async run(args, ctx: ToolContext) {
      const text = String(args.text ?? "").trim();
      if (!text) return "Error: what should I remind you about?";
      const when = parseWhen(String(args.when ?? ""));
      if (!when) return `Error: I could not understand the time "${args.when}". Use a date-time like 2026-09-27T18:00.`;
      const repeatRaw = String(args.repeat ?? "none").toLowerCase() as Repeat;
      const repeat: Repeat = REPEATS.includes(repeatRaw) ? repeatRaw : "none";
      const item = await addReminder(ctx.cfg.paths.data, { text, when, repeat });
      // Fire the toast now if it is already due (e.g. "in 1 minute" typo past).
      if (Date.parse(item.dueAt) <= Date.now()) {
        await showNotification(text, "Jarvis reminder");
      }
      const whenText = formatDue(item.dueAt);
      return repeat === "none"
        ? `Reminder set for ${whenText}: ${text}`
        : `Reminder set — ${repeat}, starting ${whenText}: ${text}`;
    },
  },
  {
    name: "remind_list",
    description: "List the user's pending reminders, soonest first.",
    safety: "auto",
    parameters: { type: "object", properties: {} },
    async run(_args, ctx: ToolContext) {
      const items = await listReminders(ctx.cfg.paths.data);
      if (!items.length) return "No reminders are set.";
      return items
        .map((r) => `- [${r.id}] ${formatDue(r.dueAt)}${r.repeat !== "none" ? ` (${r.repeat})` : ""}: ${r.text}`)
        .join("\n");
    },
  },
  {
    name: "remind_cancel",
    description: "Cancel a reminder by its text or its id (from remind_list).",
    safety: "auto",
    parameters: {
      type: "object",
      properties: { id_or_text: { type: "string", description: "Reminder id or a distinctive part of its text" } },
      required: ["id_or_text"],
    },
    async run(args, ctx: ToolContext) {
      const q = String(args.id_or_text ?? "").trim();
      const gone = await cancelReminder(ctx.cfg.paths.data, q);
      return gone ? `Cancelled the reminder "${gone.text}".` : `No reminder matched "${q}".`;
    },
  },
];
