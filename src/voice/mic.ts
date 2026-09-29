import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import { nowStamp } from "../core/util.js";
import type { VoiceConfig } from "../core/config.js";
import { rms } from "./level.js";
import { SpeechCapture } from "./capture.js";
import { transcribe } from "./stt.js";
import { transcriptMatchesWakeWord, wordsAfterWakeWord, WAKE_WINDOW_MS, WAKE_GAP_MS } from "./wake.js";

/* Picovoice modules are optional native deps, loaded lazily so the rest of the
   agent works without them. */

interface PorcupineLike {
  process(pcm: Int16Array[]): number;
  frameLength: number;
  sampleRate: number;
  release(): void;
}
interface PvRecorderLike {
  start(): void;
  stop(): void;
  read(): Promise<unknown>;
  release(): void;
  isRecording(): boolean;
}
interface PorcupineCtor {
  new (accessKey: string, keywords: Array<string | Buffer>, sensitivities: number[]): PorcupineLike;
}
interface BuiltinKeywordEnum {
  [key: string]: string;
}

const req = createRequire(import.meta.url);
let Porcupine: PorcupineCtor | null = null;
let BuiltinKeyword: BuiltinKeywordEnum | null = null;
let PvRecorder: (new (frameLength: number, deviceIndex?: number) => PvRecorderLike) | null = null;

try {
  const pv = req("@picovoice/porcupine-node");
  Porcupine = pv.Porcupine;
  BuiltinKeyword = pv.BuiltinKeyword;
  const rec = req("@picovoice/pvrecorder-node");
  PvRecorder = rec.PvRecorder;
} catch {
  /* optional — handled at runtime with setup hints */
}

export function wakeWordAvailable(): boolean {
  // Modules AND a non-empty AccessKey — otherwise wake mode would crash at startup.
  if (!Porcupine || !PvRecorder) return false;
  const key = process.env.PICOVOICE_ACCESS_KEY ?? "";
  return key.trim().length > 0;
}

/**
 * Recorder.read() shape differs between pvrecorder builds: older return
 * Int16Array[] (array of frames), newer a flat Int16Array. Normalize to a
 * flat sample array so capture works on either.
 */
function flattenChunk(chunk: unknown): Int16Array {
  if (Array.isArray(chunk)) {
    const parts = chunk as Int16Array[];
    let len = 0;
    for (const f of parts) len += f.length;
    const out = new Int16Array(len);
    let o = 0;
    for (const f of parts) {
      out.set(f, o);
      o += f.length;
    }
    return out;
  }
  return chunk as Int16Array;
}

export function recorderAvailable(): boolean {
  return PvRecorder !== null;
}

function resolveKeyword(word: string): string | Buffer {
  if (word.endsWith(".ppn")) return word;
  const key = word.toUpperCase();
  if (BuiltinKeyword && key in BuiltinKeyword) return BuiltinKeyword[key];
  throw new Error(
    `Unknown wake word "${word}". Builtin options: ${BuiltinKeyword ? Object.keys(BuiltinKeyword).join(", ").toLowerCase() : "(module missing)"} — or pass a path to a custom .ppn`,
  );
}

/** A voice session owns ONE microphone handle. */
export interface VoiceSession {
  /** Called with a WAV path after each wake+utterance, or null if nothing heard. */
  onUtterance: (wavPath: string | null) => void;
  /** Stop reacting to wake word / audio while the agent works. */
  setPaused(paused: boolean): void;
  stop(): Promise<void>;
}

async function saveWav(outDir: string, name: string, samples: number[], sampleRate: number): Promise<string | null> {
  try {
    await fs.mkdir(outDir, { recursive: true });
    const file = path.join(outDir, `${name}-${nowStamp()}.wav`);
    await writeWav(file, Int16Array.from(samples), sampleRate);
    return file;
  } catch {
    return null;
  }
}

/**
 * Porcupine wake-word session (used when a Picovoice AccessKey is configured).
 * The engine detects the wake word on-device; the utterance after it is
 * captured with the shared, sample-correct capture engine.
 */
export function startVoiceSession(cfg: VoiceConfig, dataDir: string, onUtterance: (wav: string | null) => void): VoiceSession {
  if (!Porcupine || !PvRecorder) {
    throw new Error("Porcupine modules not installed (npm i @picovoice/porcupine-node @picovoice/pvrecorder-node)");
  }
  const accessKey = process.env[cfg.access_key_env] ?? process.env.PICOVOICE_ACCESS_KEY ?? "";
  if (!accessKey) {
    throw new Error(`Missing Picovoice AccessKey: set ${cfg.access_key_env} in .env (free at console.picovoice.ai)`);
  }

  const pp = new Porcupine(accessKey, [resolveKeyword(cfg.wake_word)], [0.65]);
  const frameLen = pp.frameLength;
  const sampleRate = pp.sampleRate; // 16_000
  const recorder = new PvRecorder(frameLen, -1);
  recorder.start();

  const outDir = path.join(dataDir, "voice");
  // After the wake word: capture up to the configured max, ending on ~1.2s of
  // silence. All limits are in SAMPLES via the shared engine.
  const capture = new SpeechCapture({
    sampleRate,
    threshold: cfg.silence_threshold,
    leadMs: 150,
    endSilenceMs: 1200,
    maxMs: cfg.max_utterance_ms,
    prerollMs: 250,
  });

  let stopped = false;
  let paused = false;
  let armed = false;

  const finish = async (clip: number[]): Promise<void> => {
    const file = await saveWav(outDir, "utterance", clip, sampleRate);
    onUtterance(file);
  };

  void (async () => {
    while (!stopped) {
      const chunk = flattenChunk(await recorder.read());
      if (paused) continue;

      if (!armed) {
        const idx = pp.process([chunk]);
        if (idx !== -1) {
          armed = true;
          // Start capture immediately with a preroll; the wake word itself was
          // just spoken, so lead-time is already satisfied.
          capture.feed(chunk);
        }
        continue;
      }

      const ev = capture.feed(chunk);
      if (ev?.kind === "clip") await finish(ev.samples);
      else if (ev?.kind === "giveUp") {
        armed = false; // woke but nobody spoke — listen for the wake word again
      }
    }
  })().catch(() => {});

  return {
    onUtterance,
    setPaused(p: boolean) {
      paused = p;
    },
    async stop() {
      stopped = true;
      try {
        recorder.stop();
        recorder.release();
      } catch {
        /* ignore */
      }
      try {
        pp.release();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Always-listen session (no wake word): every speech clip goes straight to the
 * handler. Used before — kept for compatibility — but voice mode now prefers
 * startWakeListening, which gates on the wake word locally.
 */
export function startFreeListening(cfg: VoiceConfig, dataDir: string, onUtterance: (wav: string | null) => void): VoiceSession {
  if (!PvRecorder) throw new Error("PvRecorder not installed (npm i @picovoice/pvrecorder-node)");
  const frameLength = 512;
  const sampleRate = 16_000;
  const recorder = new PvRecorder(frameLength, -1);
  recorder.start();
  const outDir = path.join(dataDir, "voice");

  const capture = new SpeechCapture({
    sampleRate,
    threshold: cfg.silence_threshold,
    leadMs: 400,
    endSilenceMs: 1400,
    maxMs: cfg.max_utterance_ms,
    prerollMs: 400,
  });

  let stopped = false;
  let paused = false;

  void (async () => {
    while (!stopped) {
      const chunk = flattenChunk(await recorder.read());
      if (paused) continue;
      const ev = capture.feed(chunk);
      if (ev?.kind === "clip") {
        const file = await saveWav(outDir, "utterance", ev.samples, sampleRate);
        onUtterance(file);
      } else if (ev?.kind === "giveUp") {
        onUtterance(null);
      }
    }
  })().catch(() => {});

  return {
    onUtterance,
    setPaused(p: boolean) {
      paused = p;
      if (p) capture.flush();
    },
    async stop() {
      stopped = true;
      try {
        recorder.stop();
        recorder.release();
      } catch {
        /* ignore */
      }
    },
  };
}

/** Record one utterance with its own recorder (push-to-talk mode only — no wake listener active). */
export async function recordUtterance(cfg: VoiceConfig, outDir: string): Promise<string | null> {
  if (!PvRecorder) throw new Error("PvRecorder not installed (npm i @picovoice/pvrecorder-node)");
  const frameLength = 512;
  const sampleRate = 16_000;
  const recorder = new PvRecorder(frameLength, -1);
  recorder.start();
  const capture = new SpeechCapture({
    sampleRate,
    threshold: cfg.silence_threshold,
    leadMs: 200,
    endSilenceMs: 1200,
    maxMs: cfg.max_utterance_ms,
    prerollMs: 250,
  });
  let clip: number[] | null = null;
  try {
    // Hard stop after 8 s of silence at the very start.
    const idleDeadline = Date.now() + 8_000;
    while (Date.now() < idleDeadline) {
      const chunk = flattenChunk(await recorder.read());
      const ev = capture.feed(chunk);
      if (ev?.kind === "clip") {
        clip = ev.samples;
        break;
      }
    }
  } finally {
    try {
      recorder.stop();
      recorder.release(); // this build exposes release(), not delete()
    } catch {
      /* ignore */
    }
  }
  if (!clip) return null;
  await fs.mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `utterance-${nowStamp()}.wav`);
  await writeWav(file, Int16Array.from(clip), sampleRate);
  return file;
}

/**
 * Wake-gated always-listen session — the free "Hey Jarvis".
 *
 * Same mic + shared capture engine, but each short speech candidate is
 * transcribed by whisper LOCALLY and only counts as a wake when the wake word
 * ("jarvis") appears. The command can ride the same breath (words after the
 * wake word are forwarded) or arrive in the next utterance.
 */
export function startWakeListening(
  cfg: VoiceConfig,
  dataDir: string,
  onCommand: (payload: { wav: string | null; text: string; awaitMore: boolean }) => void,
): VoiceSession {
  if (!PvRecorder) throw new Error("PvRecorder not installed (npm i @picovoice/pvrecorder-node)");
  const frameLength = 512;
  const sampleRate = 16_000;
  const recorder = new PvRecorder(frameLength, -1);
  recorder.start();
  const outDir = path.join(dataDir, "voice");

  // Candidate clips are short: wake word + a few words, end on a 0.9s gap.
  const capture = new SpeechCapture({
    sampleRate,
    threshold: cfg.silence_threshold,
    leadMs: 400,
    endSilenceMs: WAKE_GAP_MS,
    maxMs: WAKE_WINDOW_MS,
    prerollMs: 400,
  });

  let stopped = false;
  let paused = false;
  let armed = false; // wake word heard — the NEXT utterance is a command
  let checking = false; // a whisper check is in flight

  const finish = async (clip: number[]): Promise<void> => {
    checking = true;
    try {
      const file = await saveWav(outDir, "wake", clip, sampleRate);
      if (!file) return;
      let text = "";
      try {
        text = (await transcribe(file, cfg)).trim();
      } catch {
        text = ""; // a failed check must never crash the loop
      }
      if (armed) {
        // The wake word was heard earlier — this utterance IS the command.
        armed = false;
        onCommand({ wav: file, text, awaitMore: false });
        return;
      }
      if (transcriptMatchesWakeWord(text, cfg.wake_word)) {
        const followUp = wordsAfterWakeWord(text, cfg.wake_word);
        if (followUp.length) {
          onCommand({ wav: null, text: followUp.join(" "), awaitMore: false });
        } else {
          armed = true; // bare wake — the next utterance is the command
          onCommand({ wav: null, text: "", awaitMore: true });
        }
      }
    } finally {
      checking = false;
    }
  };

  void (async () => {
    while (!stopped) {
      const chunk = flattenChunk(await recorder.read());
      if (paused) continue;
      const ev = capture.feed(chunk);
      if (ev?.kind === "clip") {
        void finish(ev.samples).catch(() => {});
      }
    }
  })().catch(() => {});

  return {
    onUtterance: (_w: string | null) => {}, // interface shim — commands flow via onCommand
    setPaused(p: boolean) {
      paused = p;
      if (p) capture.flush();
    },
    async stop() {
      stopped = true;
      try {
        recorder.stop();
        recorder.release();
      } catch {
        /* ignore */
      }
    },
  };
}

/** Minimal 16-bit mono WAV writer (used by both session and push-to-talk). */
export async function writeWav(file: string, samples: Int16Array, sampleRate: number): Promise<void> {
  const dataLen = samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt16LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
  await fs.writeFile(file, buf);
}
