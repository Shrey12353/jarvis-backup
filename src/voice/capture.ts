/**
 * Shared speech-capture state machine — the single source of truth for
 * "turn mic samples into a finished speech clip".
 *
 * All timing is in SAMPLES (16 kHz ⇒ 1 ms = 16 samples). This kills a nasty
 * class of bugs where frame counts were compared against sample counts and
 * clips were cut after ~23 ms — whisper never saw anything and voice mode
 * looked "stuck on listening".
 *
 * Capture begins only after sustained loudness (leadMs), so a clip always
 * contains speech by construction; feed() returns an event when a clip ends.
 */
import { rms } from "./level.js";

export interface CaptureConfig {
  sampleRate: number;
  /** Loudness gate (RMS) that separates speech from room noise. */
  threshold: number;
  /** Sustained loudness (ms) before we call it speech and start capturing. */
  leadMs: number;
  /** Trailing silence (ms) that ends an utterance. */
  endSilenceMs: number;
  /** Hard cap (ms) on one utterance. */
  maxMs: number;
  /** Preroll (ms) kept before speech started so first words survive. */
  prerollMs: number;
}

export interface ClipDone {
  kind: "clip";
  samples: number[];
  /** True when the clip ended because it hit the hard cap (still speaking). */
  hitMax: boolean;
}
export interface GiveUp {
  kind: "giveUp";
}
export type CaptureEvent = ClipDone | GiveUp | null;

const IDLE_TAIL_MS = 500;

export class SpeechCapture {
  private readonly cfg: CaptureConfig;
  private readonly leadSamples: number;
  private readonly endSilenceSamples: number;
  private readonly maxSamples: number;
  private readonly prerollSamples: number;
  private readonly idleTailSamples: number;

  private capturing = false;
  private silentSamples = 0;
  private totalSamples = 0;
  private loudRunSamples = 0;
  private pcm: number[] = [];

  constructor(cfg: CaptureConfig) {
    const msToSamples = (ms: number) => Math.round((ms * cfg.sampleRate) / 1000);
    this.cfg = cfg;
    this.leadSamples = msToSamples(cfg.leadMs);
    this.endSilenceSamples = msToSamples(cfg.endSilenceMs);
    this.maxSamples = msToSamples(cfg.maxMs);
    this.prerollSamples = msToSamples(cfg.prerollMs);
    this.idleTailSamples = msToSamples(IDLE_TAIL_MS);
  }

  /** Feed one mic chunk (flat samples). Returns an event when a clip ends. */
  feed(chunk: Int16Array): CaptureEvent {
    if (!this.capturing) {
      const level = rms(chunk);
      if (level > this.cfg.threshold) {
        this.loudRunSamples += chunk.length;
        for (let i = 0; i < chunk.length; i++) this.pcm.push(chunk[i]);
        if (this.pcm.length > this.idleTailSamples) this.pcm = this.pcm.slice(-this.idleTailSamples);
        if (this.loudRunSamples >= this.leadSamples) {
          // Speech started: keep a preroll so the first word survives.
          this.capturing = true;
          this.silentSamples = 0;
          this.totalSamples = this.pcm.length;
          this.pcm = this.pcm.slice(-Math.max(this.prerollSamples, this.idleTailSamples));
        }
      } else {
        this.loudRunSamples = 0;
        if (this.pcm.length > this.idleTailSamples) this.pcm = this.pcm.slice(-this.idleTailSamples);
      }
      return null;
    }

    for (let i = 0; i < chunk.length; i++) this.pcm.push(chunk[i]);
    this.totalSamples += chunk.length;
    const level = rms(chunk);
    if (level >= this.cfg.threshold) {
      this.silentSamples = 0;
    } else {
      this.silentSamples += chunk.length;
    }

    const hitMax = this.totalSamples >= this.maxSamples;
    const endSilence = this.silentSamples >= this.endSilenceSamples;

    if (hitMax || endSilence) {
      const captured = this.pcm;
      this.capturing = false;
      this.silentSamples = 0;
      this.loudRunSamples = 0;
      this.totalSamples = 0;
      this.pcm = [];
      // Too short to contain a word (~0.5 s) → nothing to check.
      if (captured.length < this.cfg.sampleRate / 2) return { kind: "giveUp" };
      return { kind: "clip", samples: captured, hitMax };
    }
    return null;
  }

  /** Force-finish any in-flight capture (e.g. the session is being paused). */
  flush(): number[] {
    const captured = this.pcm;
    this.capturing = false;
    this.silentSamples = 0;
    this.loudRunSamples = 0;
    this.totalSamples = 0;
    this.pcm = [];
    return captured;
  }

  get isCapturing(): boolean {
    return this.capturing;
  }
}
