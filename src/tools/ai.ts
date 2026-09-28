import { OllamaClient } from "../core/ollama.js";
import type { AppConfig } from "../core/config.js";
import type { Tool, ToolContext } from "./types.js";

/**
 * Direct access to the local LLM for one-shot questions. This is the building
 * block sub-agents use to "think": a script Jarvis writes can call
 * `ollama_chat` via the same registry, or simply HTTP POST to Ollama itself.
 * For the agent, it's useful for quick classifications, summaries, and
 * generating small artifacts without a full multi-step reasoning turn.
 */
export const aiTools: Tool[] = [
  {
    name: "ollama_chat",
    description:
      "Ask the local AI model a one-shot question and get its answer (no tools, no memory). Use for quick summaries, classifications, brainstorming, or generating text/code snippets. For your own multi-step reasoning, just think normally — do not call this to talk to yourself.",
    safety: "auto",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The question or instruction for the model" },
        system: { type: "string", description: "Optional persona/system prompt (e.g. a sub-agent's personality)" },
        model: { type: "string", description: "Optional model override (default: the configured model)" },
      },
      required: ["prompt"],
    },
    async run(args, ctx: ToolContext) {
      const cfg: AppConfig = ctx.cfg;
      const prompt = String(args.prompt ?? "").trim();
      if (!prompt) return "Error: prompt is required";
      const client = new OllamaClient(cfg.ollama.host);
      const messages = [] as Array<{ role: "system" | "user"; content: string }>;
      const sys = String(args.system ?? "").trim();
      if (sys) messages.push({ role: "system", content: sys });
      messages.push({ role: "user", content: prompt });
      try {
        const res = await client.chat(String(args.model || cfg.ollama.model), messages, [], {
          temperature: cfg.ollama.temperature,
          num_ctx: cfg.ollama.num_ctx,
        });
        return res.content.trim() || "(model returned an empty answer)";
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    name: "ollama_pull",
    description:
      "Download and install an Ollama model onto this PC (e.g. a vision model like 'llava:7b' or 'moondream' so images the user attaches can be understood). Big downloads can take many minutes — warn the user first.",
    safety: "ask",
    parameters: {
      type: "object",
      properties: {
        model: { type: "string", description: "Model name to pull, e.g. llava:7b, moondream, qwen2.5:3b" },
      },
      required: ["model"],
    },
    async run(args, ctx) {
      const model = String(args.model ?? "").trim();
      if (!model || !/^[\w.:/-]{2,80}$/.test(model)) return "Error: invalid model name";
      const client = new OllamaClient(ctx.cfg.ollama.host);
      try {
        if (await client.hasModel(model)) return `${model} is already installed.`;
        let last = "";
        await client.pull(model, (line) => { last = line; });
        return `Installed ${model}. Final status: ${last || "done"}`;
      } catch (e) {
        return `Error: could not install ${model} — ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
];
