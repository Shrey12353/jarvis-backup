import type { AppConfig, ToolSafety } from "../core/config.js";

export interface ToolContext {
  cfg: AppConfig;
  /** Ask the human to approve an action. Resolves true=approved. */
  confirm: (action: string, description: string) => Promise<boolean>;
  signal?: AbortSignal;
  /**
   * Live progress for long jobs ("fetching prices 420/1,225"). The UI shows it
   * as a line under the running tool so a 5-minute scan never looks stuck.
   */
  progress?: (message: string) => void;
}

export interface Tool {
  name: string;
  description: string;
  safety: ToolSafety;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

export interface ToolRegistry {
  register(tool: Tool): void;
  list(): Tool[];
  schemas(): import("../core/ollama.js").OllamaTool[];
  describe(): Array<{ name: string; description: string; safety: ToolSafety }>;
  execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<{ result: string; ok: boolean }>;
}

export class DefaultToolRegistry implements ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  schemas(): import("../core/ollama.js").OllamaTool[] {
    return this.list().map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  describe() {
    return this.list().map((t) => ({ name: t.name, description: t.description, safety: t.safety }));
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<{ result: string; ok: boolean }> {
    const tool = this.tools.get(name);
    if (!tool) return { result: `Unknown tool: ${name}`, ok: false };
    try {
      if (tool.safety === "ask" && !ctx.cfg.agent.full_auto) {
        const desc = describeCall(tool, args);
        const ok = await ctx.confirm(tool.name, desc);
        if (!ok) return { result: "User declined this action.", ok: false };
      } else if (tool.safety === "dangerous") {
        const desc = describeCall(tool, args);
        // Dangerous tier requires explicit confirmation even in full_auto,
        // unless allow_dangerous was set (user accepted the risk in config).
        if (!ctx.cfg.agent.full_auto || !ctx.cfg.agent.allow_dangerous) {
          const ok = await ctx.confirm(tool.name, `[DANGEROUS] ${desc}`);
          if (!ok) return { result: "User declined this action.", ok: false };
        }
      }
      const result = await tool.run(args, ctx);
      return { result, ok: true };
    } catch (e) {
      return { result: `Tool error: ${e instanceof Error ? e.message : String(e)}`, ok: false };
    }
  }
}

function describeCall(tool: Tool, args: Record<string, unknown>): string {
  const parts = Object.entries(args).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  return `${tool.name}(${parts.join(", ")})`;
}
