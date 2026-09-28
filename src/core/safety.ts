import type { AppConfig } from "./config.js";
import { denyCheck } from "../tools/shell.js";

export interface GateDecision {
  mode: "auto" | "ask" | "deny";
  reason: string;
}

/**
 * UI-side gate for text the user wants to submit directly as a shell command
 * (e.g. voice "run npm test"). The agent's tool gate lives in the registry.
 */
export function classifyUserCommand(cmd: string, cfg: AppConfig): GateDecision {
  const deny = denyCheck(cmd);
  if (deny) return { mode: "deny", reason: deny };
  const readOnly = /^(\s*)(dir|ls|cat|type|git status|git log|git diff|git branch|node -v|npm (run|test|ls)|echo|pwd|whoami|systeminfo|ver)\b/i;
  if (readOnly.test(cmd)) return { mode: "auto", reason: "read-only" };
  if (cfg.agent.full_auto) return { mode: "auto", reason: "full_auto enabled" };
  return { mode: "ask", reason: "state-changing command" };
}

/** Tools that always require explicit per-call approval unless allow_dangerous+full_auto. */
export function needsExplicitApproval(toolSafety: "auto" | "ask" | "dangerous", cfg: AppConfig): boolean {
  if (toolSafety === "auto") return false;
  if (toolSafety === "dangerous") return !(cfg.agent.full_auto && cfg.agent.allow_dangerous);
  return !cfg.agent.full_auto;
}
