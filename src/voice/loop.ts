import readline from "node:readline";
import { Agent } from "../core/agent.js";
import type { AppConfig } from "../core/config.js";
import { startVoiceSession, startFreeListening, startWakeListening, recordUtterance, wakeWordAvailable } from "./mic.js";
import { transcribe } from "./stt.js";
import { speak } from "./tts.js";

/**
 * Voice mode. With a Picovoice key: say the wake word ("jarvis"), speak your
 * command, wait — the answer is spoken back. Without a key: push-to-talk
 * (Enter, speak, Enter). In both modes you can also just TYPE a command
 * instead of speaking — handy when the mic is noisy.
 */
export async function voiceLoop(cfg: AppConfig, agent: Agent): Promise<void> {
  const say = (m: string) => console.log(m);
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  let typed: string | null = null;
  let exiting = false;
  rl.on("line", (l) => {
    const t = l.trim();
    const low = t.toLowerCase();
    if (low === "exit" || low === "quit") {
      exiting = true;
      return;
    }
    if (t) typed = t;
  });

  const confirm = async (action: string, description: string): Promise<boolean> => {
    await speak(`Approval needed for ${action}`, cfg.voice).catch(() => {});
    say(`⚠️  APPROVAL NEEDED — ${action}\n   ${description}\n   (say/type "yes" to allow, "no" to cancel)`);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && !exiting) {
      const v2 = typed as string | null;
      typed = null;
      const ans = v2 ?? (await listenForYesNo(cfg));
      if (ans === null) continue;
      if (/^(y(es)?|ok|approve|allow|do it|confirm)/i.test(ans)) return true;
      if (/^(no|n|cancel|stop|don't|deny)/i.test(ans)) return false;
      say("   (didn't catch that — yes or no?)");
    }
    return false;
  };

  const handleUtterance = async (wav: string | null): Promise<void> => {
    try {
      if (!wav) {
        say("(no speech detected)");
        return;
      }
      const text = (await transcribe(wav, cfg.voice)).trim();
      say(`🗣  You: ${text || "(empty transcription)"}`);
      if (!text) return;
      await runAgentTurn(agent, cfg, text, confirm);
    } catch (e) {
      say(`Voice error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  if (!wakeWordAvailable()) {
    // Free wake-word mode: whisper locally checks every short speech clip for
    // the wake word ("jarvis"). Nothing is sent anywhere and no key is needed.
    say("🎧 Wake-word mode (free, local): say \"Jarvis\" — then speak your command.");
    say("   Example: \"Jarvis, what's on my calendar today?\"");
    say("   You can also TYPE a command. Type 'exit' to quit.\n");
    say("   Listening for the wake word…");
    let busy = false;
    const session = startWakeListening(cfg.voice, cfg.paths.data, (p) => {
      if (busy || exiting) return;
      if (p.awaitMore) {
        say("🔔 I'm listening — go ahead.");
        void speak("I'm listening", cfg.voice).catch(() => {});
        return;
      }
      if (!p.wav && !p.text) return; // spurious empty event
      busy = true;
      session.setPaused(true);
      const runIt = p.text
        ? runAgentTurn(agent, cfg, p.text, confirm).catch((e) =>
            say(`Voice error: ${e instanceof Error ? e.message : String(e)}`),
          )
        : handleUtterance(p.wav); // text-less wav: full pipeline inside
      void runIt.finally(() => {
        busy = false;
        session.setPaused(false);
        say("…listening for the wake word again");
      });
    });
    // Typed commands still work while idle.
    for (;;) {
      if (exiting) break;
      if (busy) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      const v = typed as string | null;
      if (v !== null) {
        typed = null;
        const low = v.toLowerCase();
        if (low === "exit" || low === "quit") break;
        busy = true;
        session.setPaused(true);
        await runAgentTurn(agent, cfg, v, confirm).finally(() => {
          busy = false;
          session.setPaused(false);
          say("…listening — speak when ready");
        });
        continue;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    await session.stop();
    rl.close();
    say("Voice mode ended.");
    return;
  }

  say(`🎧 Wake word mode active — say "${cfg.voice.wake_word}" then speak your command.`);
  say("   You can also type a command instead of speaking. Type 'exit' to quit.\n");
  say("   Waiting for the wake word…");

  let busy = false;
  const session = startVoiceSession(cfg.voice, cfg.paths.data, (wav) => {
    if (busy || exiting) return;
    busy = true;
    session.setPaused(true);
    void handleUtterance(wav)
      .finally(() => {
        busy = false;
        session.setPaused(false);
        say("…listening for the wake word again");
      });
  });

  // Also serve typed commands while idle (not while the agent is working)
  for (;;) {
    if (exiting) break;
    if (busy) {
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }
    const v = typed as string | null;
    if (v !== null) {
      typed = null;
      const low = v.toLowerCase();
      if (low === "exit" || low === "quit") break;
      busy = true;
      session.setPaused(true);
      await runAgentTurn(agent, cfg, v, confirm).finally(() => {
        busy = false;
        session.setPaused(false);
        say("…listening for the wake word again");
      });
      continue;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  await session.stop();
  rl.close();
  say("Voice mode ended.");
}

async function runAgentTurn(
  agent: Agent,
  cfg: AppConfig,
  text: string,
  confirm: (action: string, description: string) => Promise<boolean>
): Promise<void> {
  const result = await agent.run(text, {
    confirm,
    onToolCall: (name, args) =>
      console.log(`🔧 ${name} ${Object.entries(args).map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 60)}`).join(" ")}`),
    onToolResult: (name, result, ok) =>
      console.log(`   ↳ ${name}: ${ok ? "ok" : "FAILED"} — ${result.split("\n")[0].slice(0, 120)}`),
    onContent: (d) => process.stdout.write(d),
  });
  process.stdout.write("\n");
  const answer = result.answer;
  if (answer) await speak(answer, cfg.voice).catch(() => {});
}

/** Best-effort yes/no capture while a confirmation is pending. */
async function listenForYesNo(cfg: AppConfig): Promise<string | null> {
  try {
    const wav = await recordUtterance(cfg.voice, `${cfg.paths.data}/voice`);
    if (!wav) return null;
    return (await transcribe(wav, cfg.voice)).trim().toLowerCase() || null;
  } catch {
    return null;
  }
}
