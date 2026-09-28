import type { Tool, ToolContext } from "./types.js";
import { addFacts, listFacts, removeFact } from "../core/memory.js";

/**
 * Long-term memory tools — how Jarvis stops asking the same questions.
 * Facts are saved as plain text the user can read and edit.
 */
export const memoryTools: Tool[] = [
  {
    name: "remember",
    description:
      "Save a durable fact about the user in long-term memory (name, work, study, city, goals, preferences, important dates). Use whenever the user tells you something worth keeping — no permission needed.",
    safety: "auto",
    parameters: {
      type: "object",
      properties: {
        fact: { type: "string", description: "One short fact, written in third person, e.g. \"Lives in Mumbai and studies for CA Final\"" },
      },
      required: ["fact"],
    },
    async run(args, ctx: ToolContext) {
      const fact = String(args.fact ?? "").trim();
      if (fact.length < 2) return "Error: nothing to remember (empty fact).";
      const added = await addFacts(ctx.cfg.paths.data, [fact]);
      if (!added) return `Already remembered something equivalent: "${fact}" (no duplicate saved).`;
      return `Remembered: ${fact}`;
    },
  },
  {
    name: "forget",
    description: "Remove a fact from long-term memory when the user asks you to forget something.",
    safety: "auto",
    parameters: {
      type: "object",
      properties: {
        fact: { type: "string", description: "The fact text (or a distinctive part of it) to remove" },
      },
      required: ["fact"],
    },
    async run(args, ctx: ToolContext) {
      const fact = String(args.fact ?? "").trim();
      if (!fact) return "Error: which fact should I forget?";
      const gone = await removeFact(ctx.cfg.paths.data, fact);
      return gone ? `Forgotten: ${fact}` : `I couldn't find a memory matching "${fact}".`;
    },
  },
  {
    name: "memory_list",
    description: "List everything currently in long-term memory (what you know about the user).",
    safety: "auto",
    parameters: { type: "object", properties: {} },
    async run(_args, ctx: ToolContext) {
      const facts = await listFacts(ctx.cfg.paths.data);
      if (!facts.length) return "Long-term memory is empty — I don't know anything about the user yet.";
      return facts.map((f, i) => `${i + 1}. ${f.text}${f.addedAt ? ` (saved ${f.addedAt})` : ""}`).join("\n");
    },
  },
];
