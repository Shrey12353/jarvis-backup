/**
 * Free wake-word layer — no Picovoice, no key, no cloud.
 *
 * Strategy: the mic always runs a cheap loudness VAD (same as always-listen),
 * but short candidate clips are transcribed LOCALLY by whisper and only count
 * as a wake event when the wake word ("jarvis") is present in the transcript.
 * Everything happens on this PC.
 */

/** True when a transcript plausibly contains the wake word. */
export function transcriptMatchesWakeWord(transcript: string, wakeWord: string): boolean {
  const text = transcript.toLowerCase().replace(/[^a-z\s]/g, " ");
  const word = wakeWord.toLowerCase().replace(/[^a-z]/g, "");
  if (!word) return false;
  // Exact word (with word boundaries) is always accepted.
  if (new RegExp(`\\b${word}\\b`).test(text)) return true;
  // whisper mishears "jarvis" as "jervis"/"jarvic"/"gervis" — accept small
  // edit variants of the first syllables: match the first 4 letters, allowing
  // one substitution inside them (j/g, a/e, r/v swaps are common).
  const stem = word.slice(0, Math.min(4, word.length));
  const variants = [stem, stem.replace("j", "g"), stem.replace("a", "e"), stem.replace("r", "v")];
  return text.split(/\s+/).some((tok) => {
    if (tok.length < Math.max(3, stem.length - 1) || tok.length > stem.length + 3) return false;
    let diffs = 0;
    for (let i = 0; i < Math.min(stem.length, tok.length); i++) if (stem[i] !== tok[i]) diffs++;
    return diffs <= 1 && variants.some((v) => tok.startsWith(v.slice(0, 3)));
  });
}

/** Words spoken AFTER the wake word in the same breath — reuse as the command. */
export function wordsAfterWakeWord(transcript: string, wakeWord: string): string[] {
  const text = transcript.toLowerCase().replace(/[^a-z\s]/g, " ");
  const word = wakeWord.toLowerCase().replace(/[^a-z]/g, "");
  const m = new RegExp(`\\b${word}\\w{0,2}\\b`).exec(text);
  if (!m) return [];
  return text.slice(m.index + m[0].length).trim().split(/\s+/).filter(Boolean);
}

/** Wake capture ends on a 0.9s silence gap or a hard 4.5s cap. */
export const WAKE_WINDOW_MS = 4_500;
export const WAKE_GAP_MS = 900;
