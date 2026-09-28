export function nowStamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function truncate(s: string, max = 8_000): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n...[truncated ${s.length - max} chars]`;
}

/** Extract the first JSON object from text that may contain prose or code fences. */
export function extractJson(text: string): unknown | undefined {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fence?.[1]) candidates.push(fence[1].trim());
  const firstBrace = text.indexOf("{");
  if (firstBrace !== -1) {
    // try progressively from first brace: naive but works with a repair pass below
    candidates.push(text.slice(firstBrace));
  }
  for (const c of candidates) {
    const parsed = tryParse(c);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function tryParse(s: string): unknown | undefined {
  const attempts = [s, repairJson(s)];
  for (const a of attempts) {
    try {
      const v = JSON.parse(a);
      if (v && typeof v === "object") return v;
    } catch {
      /* next */
    }
  }
  return undefined;
}

/** Common local-LLM JSON fixes: trailing commas, single quotes, missing closing braces. */
export function repairJson(s: string): string {
  let out = s.trim();
  // remove trailing commas
  out = out.replace(/,\s*([}\]])/g, "$1");
  // balance braces/brackets
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (const ch of out) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  while (stack.length) {
    const open = stack.pop();
    out += open === "{" ? "}" : "]";
  }
  return out;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
