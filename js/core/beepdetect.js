// Hears Richta's beep in the tablet microphone's spectrum. Frames are dB per frequency bin (as an
// AnalyserNode gives them). Learning, during Richta's Sound Check at check-in: the narrow tones that stand
// well above the sound around them are the beep's. Listening: a frame matches when a learned tone stands
// out by enough decibels; a beep is a run of matching frames about as long as the learned ones.

const LO_HZ = 400, HI_HZ = 7000, WIN = 24;   // band searched; neighbourhood (bins each side) for the background

// How far bin i stands above the median of its neighbourhood, in dB.
function contrastAt(frame, i) {
  const a = Math.max(0, i - WIN), b = Math.min(frame.length - 1, i + WIN), v = [];
  for (let j = a; j <= b; j++) if (Math.abs(j - i) > 2) v.push(frame[j]);
  v.sort((x, y) => x - y);
  return frame[i] - v[v.length >> 1];
}
function bestPeak(frame, lo, hi) {
  let best = { bin: -1, c: -Infinity };
  for (let i = lo; i <= hi; i++) {
    if (frame[i] < frame[i - 1] || frame[i] < frame[i + 1]) continue;   // local maxima only
    const c = contrastAt(frame, i);
    if (c > best.c) best = { bin: i, c };
  }
  return best;
}

// frames: dB arrays recorded while Richta beeped; binHz: Hz per bin; frameS: seconds per frame.
// Returns { tones: [Hz], minFrames, minDb, binHz } or null if no clear beep was heard.
export function learnTones(frames, { binHz, frameS }) {
  const lo = Math.max(2, Math.floor(LO_HZ / binHz)), hi = Math.min(frames[0]?.length - 3, Math.ceil(HI_HZ / binHz));
  const hits = frames.map((f) => bestPeak(f, lo, hi)).map((p) => (p.c >= 18 ? p : null));
  const count = new Map();
  for (const p of hits) if (p) count.set(p.bin, (count.get(p.bin) || 0) + 1);
  if (!count.size) return null;
  // Group neighbouring bins (±2): the beep's tones.
  const tones = [];
  for (const [bin] of [...count.entries()].sort((a, b) => b[1] - a[1])) {
    if (tones.some((t) => Math.abs(t.bin - bin) <= 2)) { tones.find((t) => Math.abs(t.bin - bin) <= 2).n += count.get(bin); continue; }
    tones.push({ bin, n: count.get(bin) });
  }
  const strong = tones.filter((t) => t.n >= 2).slice(0, 3);
  if (!strong.length) return null;
  // Typical run of consecutive tone frames, and how strong the tone was.
  const runs = [];
  let run = 0;
  for (const p of hits) {
    const on = p && strong.some((t) => Math.abs(t.bin - p.bin) <= 2);
    if (on) run++; else if (run) { runs.push(run); run = 0; }
  }
  if (run) runs.push(run);
  runs.sort((a, b) => a - b);
  const cs = hits.filter((p) => p && strong.some((t) => Math.abs(t.bin - p.bin) <= 2)).map((p) => p.c).sort((a, b) => a - b);
  return {
    tones: strong.map((t) => Math.round(t.bin * binHz)),
    minFrames: Math.max(2, Math.floor(0.6 * runs[runs.length >> 1])),
    maxFrames: Math.max(8, Math.ceil(2.5 * runs[runs.length - 1]) + Math.ceil(0.3 / frameS)),
    minDb: Math.max(12, 0.6 * cs[cs.length >> 1]),
    binHz,
  };
}

// Feed it frames as they come; push() returns true once per beep heard, as the beep ends (so a long tone,
// which isn't a beep, can be told apart). Strict, after false beeps on the road (chimes, music, voices): the
// beep's tone must be the strongest narrow tone in the whole band, by 15 dB at least, for 3 frames at least,
// and beeps are 10 s apart at the closest.
export class BeepDetector {
  constructor(sound, { binHz = sound.binHz, frameS = 0.03, refractoryS = 10 } = {}) {
    this.sound = sound; this.binHz = binHz; this.frameS = frameS; this.refractoryS = refractoryS;
    this.bins = sound.tones.map((hz) => Math.round(hz / binHz));
    this.lo = Math.max(2, Math.floor(LO_HZ / binHz)); this.hi = Math.ceil(HI_HZ / binHz);
    this.minDb = Math.max(15, sound.minDb); this.minFrames = Math.max(3, sound.minFrames);
    this.run = 0; this.quietUntil = -Infinity;
  }
  matches(frame) {
    const p = bestPeak(frame, this.lo, Math.min(this.hi, frame.length - 2));
    return p.c >= this.minDb && this.bins.some((b) => Math.abs(p.bin - b) <= 2);
  }
  // t: seconds. muted: our own voice is speaking (never count it).
  push(frame, t, muted = false) {
    if (muted) { this.run = 0; return false; }
    if (this.matches(frame)) { this.run++; return false; }
    const run = this.run;
    this.run = 0;
    if (run >= this.minFrames && run <= this.sound.maxFrames && t >= this.quietUntil) { this.quietUntil = t + this.refractoryS; return true; }
    return false;
  }
}
