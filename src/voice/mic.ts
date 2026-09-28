import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import { nowStamp } from "../core/util.js";
import type { VoiceConfig } from "../core/config.js";
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
  read(): Promise<Int16Array[]>;
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
    for (const f of parts) { out.set(f, o); o += f.length; }
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
    `Unknown wake word "${word}". Builtin options: ${BuiltinKeyword ? Object.keys(BuiltinKeyword).join(", ").toLowerCase() : "(module missing)"} — or pass a path to a custom .ppn`
  );
}

/**
 * A single voice session owns ONE microphone handle. The same recorder feeds
 * wake-word detection and utterance capture — no second mic open, which is
 * what breaks voice mode on Windows if done naively.
 */
export interface VoiceSession {
  /** Called with a WAV path after each wake+utterance, or null if nothing heard. */
  onUtterance: (wavPath: string | null) => void;
  /** Stop reacting to wake word / audio while the agent works. */
  setPaused(paused: boolean): void;
  stop(): Promise<void>;
}

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

  const frameMs = (frameLen / sampleRate) * 1000;
  const silenceLimitFrames = Math.round(1200 / frameMs);
  const maxFrames = Math.round(cfg.max_utterance_ms / frameMs);
  const noSpeechLimitFrames = Math.round(3000 / frameMs);

  let stopped = false;
  let paused = false;
  let capturing = false;
  let speechStarted = false;
  let silentFrames = 0;
  let frames = 0;
  let pcm: number[] = [];

  const finishCapture = async (): Promise<void> => {
    capturing = false;
    speechStarted = false;
    silentFrames = 0;
    frames = 0;
    const captured = pcm;
    pcm = [];
    if (!captured.length || captured.length < sampleRate / 2) {
      onUtterance(null);
      return;
    }
    try {
      await fs.mkdir(outDir, { recursive: true });
      const file = path.join(outDir, `utterance-${nowStamp()}.wav`);
      await writeWav(file, Int16Array.from(captured), sampleRate);
      onUtterance(file);
    } catch {
      onUtterance(null);
    }
  };

  void (async () => {
    while (!stopped) {
      const chunk = flattenChunk(await recorder.read());
      if (paused) continue;

      if (!capturing) {
        const idx = pp.process([chunk]);
        if (idx !== -1) {
          capturing = true;
          speechStarted = false;
          silentFrames = 0;
          frames = 0;
          pcm = [];
        }
        continue;
      }

      // capturing an utterance
      for (let i = 0; i < chunk.length; i++) pcm.push(chunk[i]);
      frames += 1;
      const tail = pcm.slice(-Math.min(pcm.length, frameLen * 8));
      const level = rms(tail);
      if (!speechStarted && level > cfg.silence_threshold) speechStarted = true;

      if (speechStarted) {
        if (level < cfg.silence_threshold) {
          silentFrames += chunk.length;
          if (silentFrames > silenceLimitFrames || frames > maxFrames) {
            await finishCapture();
          }
        } else {
          silentFrames = 0;
          if (frames > maxFrames) await finishCapture();
        }
      } else if (frames > noSpeechLimitFrames) {
        // woke but nobody spoke
        await finishCapture();
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
        recorder.release(); // this build exposes release(), not delete()
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

function rms(buf: number[]): number {
  let sum = 0;
  const step = Math.max(1, Math.floor(buf.length / 2000));
  let n = 0;
  for (let i = 0; i < buf.length; i += step) {
    sum += buf[i] * buf[i];
    n++;
  }
  return n ? Math.sqrt(sum / n) : 0;
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
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
  await fs.writeFile(file, buf);
}

/**
 * Hands-free listening WITHOUT any wake-word key: a voice-activity listener
 * that wakes on any sustained speech (no keyword needed), captures the
 * utterance, and reports it. Same session shape as startVoiceSession.
 */
export function startFreeListening(cfg: VoiceConfig, dataDir: string, onUtterance: (wav: string | null) => void): VoiceSession {
  if (!PvRecorder) throw new Error("PvRecorder not installed (npm i @picovoice/pvrecorder-node)");
  const frameLength = 512;
  const sampleRate = 16_000;
  const recorder = new PvRecorder(frameLength, -1);
  recorder.start();
  const outDir = path.join(dataDir, "voice");

  const frameMs = (frameLength / sampleRate) * 1000;
  const silenceLimitFrames = Math.round(1400 / frameMs);
  const maxFrames = Math.round(cfg.max_utterance_ms / frameMs);
  const leadFrames = Math.round(400 / frameMs); // sustained loudness before we call it speech
  const gapFrames = Math.round(700 / frameMs); // max silence mid-speech before we cut

  let stopped = false;
  let paused = false;
  let capturing = false;
  let speechStarted = false;
  let loudRun = 0;
  let silentFrames = 0;
  let frames = 0;
  let pcm: number[] = [];

  const finish = async (): Promise<void> => {
    capturing = false;
    speechStarted = false;
    silentFrames = 0;
    loudRun = 0;
    frames = 0;
    const captured = pcm;
    pcm = [];
    if (!speechStarted || captured.length < sampleRate / 2) {
      onUtterance(null);
      return;
    }
    try {
      await fs.mkdir(outDir, { recursive: true });
      const file = path.join(outDir, `utterance-${nowStamp()}.wav`);
      await writeWav(file, Int16Array.from(captured), sampleRate);
      onUtterance(file);
    } catch {
      onUtterance(null);
    }
  };

  void (async () => {
    while (!stopped) {
      const chunk = flattenChunk(await recorder.read());
      if (paused) continue;
      for (let i = 0; i < chunk.length; i++) pcm.push(chunk[i]);
      frames += chunk.length;
      const tail = pcm.slice(-Math.min(pcm.length, frameLength * 8));
      const level = rms(tail);

      if (!capturing) {
        // Idle: wait for sustained loudness — a door slam shouldn't wake him.
        if (level > cfg.silence_threshold) {
          if (++loudRun >= Math.round(leadFrames / chunk.length)) {
            capturing = true;
            speechStarted = true;
            silentFrames = 0;
            frames = 0;
            pcm = pcm.slice(-frameLength * 4); // small pre-roll so first words survive
          }
        } else {
          loudRun = 0;
          if (pcm.length > frameLength * 20) pcm = pcm.slice(-frameLength * 4);
        }
        continue;
      }

      if (level >= cfg.silence_threshold) {
        silentFrames = 0;
      } else {
        silentFrames += chunk.length;
      }
      if (silentFrames > silenceLimitFrames || frames > maxFrames || silentFrames > gapFrames + silenceLimitFrames) {
        await finish();
      }
    }
  })().catch(() => {});

  return {
    onUtterance,
    setPaused(p: boolean) {
      paused = p;
      if (p) {
        capturing = false;
        speechStarted = false;
        pcm = [];
        frames = 0;
        loudRun = 0;
      }
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
  const pcm: number[] = [];
  const frameMs = (frameLength / sampleRate) * 1000;
  let speechStarted = false;
  let silentFrames = 0;
  const silenceLimitFrames = Math.round(1200 / frameMs);
  const maxFrames = Math.round(cfg.max_utterance_ms / frameMs);
  const noSpeechFrames = Math.round(8000 / frameMs);
  let frames = 0;
  try {
    while (frames < maxFrames) {
      const chunk = flattenChunk(await recorder.read());
      for (let i = 0; i < chunk.length; i++) pcm.push(chunk[i]);
      frames += chunk.length;
      const tail = pcm.slice(-Math.min(pcm.length, frameLength * 8));
      const level = rms(tail);
      if (!speechStarted) {
        if (level > cfg.silence_threshold) speechStarted = true;
        else if (frames > noSpeechFrames) return null;
        continue;
      }
      if (level < cfg.silence_threshold) {
        silentFrames += chunk.length;
        if (silentFrames > silenceLimitFrames) break;
      } else {
        silentFrames = 0;
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
  if (!speechStarted || pcm.length < sampleRate / 2) return null;
  await fs.mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `utterance-${nowStamp()}.wav`);
  await writeWav(file, Int16Array.from(pcm), sampleRate);
  return file;
}

/**
 * Wake-gated always-listen session — the free "Hey Jarvis".
 *
 * Same mic + loudness VAD as startFreeListening, but each short speech
 * candidate is transcribed by whisper LOCALLY and only counts as a wake when
 * the wake word ("jarvis") appears. The command can ride the same breath
 * (words after the wake word are forwarded) or arrive in the next utterance.
 * If the wake word is heard but nothing follows, a chime-like prompt plays.
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

  const frameMs = (frameLength / sampleRate) * 1000;
  const leadFrames = Math.round(400 / frameMs);
  const silenceLimitFrames = Math.round(WAKE_GAP_MS / frameMs);
  const maxFrames = Math.round(WAKE_WINDOW_MS / frameMs);

  let stopped = false;
  let paused = false;
  let capturing = false;
  let speechStarted = false;
  let loudRun = 0;
  let silentFrames = 0;
  let frames = 0;
  let pcm: number[] = [];
  let armed = false; // wake word heard — the NEXT utterance is a command

  const finish = async (): Promise<void> => {
    capturing = false;
    speechStarted = false;
    silentFrames = 0;
    loudRun = 0;
    frames = 0;
    const captured = pcm;
    pcm = [];
    if (!speechStarted || captured.length < sampleRate / 2) return;
    try {
      await fs.mkdir(outDir, { recursive: true });
      const file = path.join(outDir, `wake-${nowStamp()}.wav`);
      await writeWav(file, Int16Array.from(captured), sampleRate);
      if (armed) {
        // The wake word was heard earlier — this utterance IS the command.
        armed = false;
        let text = "";
        try {
          text = (await transcribe(file, cfg)).trim();
        } catch {
          text = "";
        }
        onCommand({ wav: file, text, awaitMore: false });
        return;
      }
      let text = "";
      try {
        text = (await transcribe(file, cfg)).toLowerCase();
      } catch {
        text = ""; // a failed check must never crash the loop
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
    } catch {
      /* ignore */
    }
  };

  void (async () => {
    while (!stopped) {
      const chunk = flattenChunk(await recorder.read());
      if (paused) continue;
      for (let i = 0; i < chunk.length; i++) pcm.push(chunk[i]);
      frames += chunk.length;
      const tail = pcm.slice(-Math.min(pcm.length, frameLength * 8));
      const level = rms(tail);

      if (!capturing) {
        if (level > cfg.silence_threshold) {
          if (++loudRun >= Math.round(leadFrames / chunk.length)) {
            capturing = true;
            speechStarted = true;
            silentFrames = 0;
            frames = 0;
            pcm = pcm.slice(-frameLength * 4);
          }
        } else {
          loudRun = 0;
          if (pcm.length > frameLength * 20) pcm = pcm.slice(-frameLength * 4);
        }
        continue;
      }

      if (level >= cfg.silence_threshold) {
        silentFrames = 0;
      } else {
        silentFrames += chunk.length;
      }
      if (silentFrames > silenceLimitFrames || frames > maxFrames) await finish();
    }
  })().catch(() => {});

  return {
    onUtterance: (_w: string | null) => {}, // interface shim — commands flow via onCommand
    setPaused(p: boolean) {
      paused = p;
      if (p) {
        capturing = false;
        speechStarted = false;
        pcm = [];
        frames = 0;
        loudRun = 0;
      }
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
