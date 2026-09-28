import { run } from "../core/proc.js";
import type { VoiceConfig } from "../core/config.js";

/** Speak text aloud. Fire-and-wait; keep input short (agent answers are concise). */
export async function speak(text: string, cfg: VoiceConfig): Promise<void> {
  const engine = cfg.tts.engine;
  if (engine === "none" || !text.trim()) return;
  const clean = text.replace(/[\\'"]/g, " ").replace(/\s+/g, " ").trim().slice(0, 800);
  try {
    if (engine === "sapi") {
      const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = ${Number(cfg.tts.rate) || 0}; $s.Speak('${clean}'); $s.Dispose()`;
      await run(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { timeoutMs: 60_000 });
      return;
    }
    if (engine === "say") {
      await run(`say ${Number(cfg.tts.rate) ? `-r ${Number(cfg.tts.rate) * 50}` : ""} "${clean}"`, { timeoutMs: 60_000 });
      return;
    }
    if (engine === "spd-say") {
      await run(`spd-say -w "${clean}"`, { timeoutMs: 60_000 });
      return;
    }
  } catch {
    /* TTS is best-effort; never break the loop over it */
  }
}
