/** RMS loudness of a sample block (16-bit PCM). Shared by capture + sessions. */
export function rms(buf: Int16Array | number[]): number {
  let sum = 0;
  const step = Math.max(1, Math.floor(buf.length / 500));
  let n = 0;
  for (let i = 0; i < buf.length; i += step) {
    const v = buf[i] as number;
    sum += v * v;
    n++;
  }
  return n ? Math.sqrt(sum / n) : 0;
}
