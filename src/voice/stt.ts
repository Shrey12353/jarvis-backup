import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import { run } from "../core/proc.js";
import type { VoiceConfig } from "../core/config.js";

const req = createRequire(import.meta.url);

/** Transcribe a WAV file using the configured local engine. */
export async function transcribe(wavPath: string, cfg: VoiceConfig): Promise<string> {
  if (cfg.stt.command) return whisperCpp(wavPath, cfg.stt.command);
  if (cfg.stt.vosk_model) return vosk(wavPath, cfg.stt.vosk_model);
  throw new Error(
    "No speech-to-text configured. Set voice.stt.command (whisper.cpp, recommended) or voice.stt.vosk_model in config.yaml. See README."
  );
}

async function whisperCpp(wavPath: string, command: string): Promise<string> {
  const cmd = command.replace("{wav}", wavPath);
  const r = await run(cmd, { timeoutMs: 120_000 });
  if (r.code !== 0 && !r.stdout.trim()) {
    throw new Error(`whisper.cpp failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  }
  return cleanTranscript(r.stdout);
}

async function vosk(wavPath: string, modelPath: string): Promise<string> {
  let Vosk: any;
  try {
    Vosk = req("vosk");
  } catch {
    throw new Error("vosk not installed: npm i vosk");
  }
  try { Vosk.setLogLevel(-1); } catch { /* ignore */ }
  const model = new Vosk.Model(modelPath);
  const pcm = await readPcm(wavPath);
  const rec = new Vosk.Recognizer({ model, sampleRate: 16_000 });
  const CH = 8192;
  for (let i = 0; i < pcm.length; i += CH) {
    rec.acceptWaveform(Buffer.from(pcm.buffer, pcm.byteOffset + i * 2, Math.min(CH, pcm.length - i) * 2));
  }
  const final = JSON.parse(rec.finalResult());
  rec.free();
  model.free();
  return String(final.text ?? "").trim();
}

/** Read a 16-bit mono WAV and return the raw Int16 samples (assumes standard 44-byte header). */
async function readPcm(wavPath: string): Promise<Int16Array> {
  const buf = await fs.readFile(wavPath);
  const dataIdx = buf.indexOf("data", 12, "ascii");
  const start = dataIdx + 8;
  const out = new Int16Array(Math.floor((buf.length - start) / 2));
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(start + i * 2);
  return out;
}

function cleanTranscript(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^\[?(WARN|INFO|whisper|system_info|main:)/i.test(l))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
