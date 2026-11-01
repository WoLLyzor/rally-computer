// Plan (design §6.5): predicted losses at known delays and the planned time offset.
// Checkpoint locations are unknown, so a fraction α of each expected loss is banked before the delay
// and the rest is recovered after it (α = 0.5; 0 when the GIs promise no checkpoint after stops).

const MPH = 0.44704;   // m/s per mph

// Time lost slowing from v to vSlow and back, plus a dwell (seconds). v, vSlow in m/s.
export function slowdownLossS(v, vSlow = 0, { aDecel = 2.5, aAccel = 1.8, dwellS = 0 } = {}) {
  if (!(v > 0) || vSlow >= v) return dwellS;
  return ((v - vSlow) ** 2 / (2 * v)) * (1 / aDecel + 1 / aAccel) + dwellS;
}

// Default delay model per cue; the practice drive calibrates these numbers.
export const DELAY_MODEL = {
  stop: { vSlowMph: 0, dwellS: 2 },
  T: { vSlowMph: 0, dwellS: 2 },        // most T junctions have a stop
  yield: { vSlowMph: 8, dwellS: 1 },
  signal: { vSlowMph: 0, dwellS: 8 },    // expected share of a red light
  turn: { vSlowMph: 15, dwellS: 0 },
  rrx: { vSlowMph: 20, dwellS: 0 },
  covered_bridge: { vSlowMph: 10, dwellS: 5 },
};

// rows: resolved instructions (with D). hazards: [{D, kind}] from the map (covered bridges, rail crossings).
// castAt(D) gives the CAST before the point. Returns [{D, lossS, kind, n}].
export function buildDelays(rows, { hazards = [], castAt, model = DELAY_MODEL } = {}) {
  const out = [];
  for (const r of rows) {
    if (r.D === null || r.D === undefined) continue;
    const cast = castAt(r.D - 1e-6);
    if (!(cast > 0)) continue;
    let kind = null;
    if (r.action === 'turn' || r.cue) {
      if (r.cue === 'stop' || r.cue === 'T') kind = r.cue;
      else if (r.cue === 'yield' || r.cue === 'signal') kind = r.cue;
      else if (r.action === 'turn' && r.dir && r.dir !== 'S') kind = 'turn';
    }
    if (r.pause_s > 0) kind = null;    // the rallymaster already gave time here
    if (!kind) continue;
    const m = model[kind];
    out.push({ D: r.D, n: r.n, kind, lossS: slowdownLossS(cast * MPH, m.vSlowMph * MPH, { dwellS: m.dwellS }) });
  }
  for (const h of hazards) {
    const cast = castAt(h.D - 1e-6);
    const m = model[h.kind];
    if (!(cast > 0) || !m) continue;
    out.push({ D: h.D, n: null, kind: h.kind, lossS: slowdownLossS(cast * MPH, m.vSlowMph * MPH, { dwellS: m.dwellS }) });
  }
  return out.sort((a, b) => a.D - b.D);
}

// Planned offset at D (seconds, negative = planned early). capAt(D) gives the speed cap in effect.
// Each delay ramps in over R miles before it, sized to need only half the legal gain rate.
export function plannedOffsetFn(delays, { alpha = 0.5, castAt, capAt }) {
  const ramps = [];
  if (alpha > 0) {
    for (const d of delays) {
      const c = castAt(d.D - 1e-6), cap = capAt(d.D - 1e-6);
      if (!(c > 0) || !(cap > c)) continue;            // no legal room to bank
      const gain = 3600 / c - 3600 / cap;               // s per mile at the cap
      const bank = alpha * d.lossS;
      const R = Math.min(1.0, Math.max(0.15, bank / (0.5 * gain)));
      ramps.push({ D: d.D, R, bank });
    }
  }
  return (D) => {
    let off = 0;
    for (const r of ramps) {
      if (D >= r.D || D <= r.D - r.R) continue;
      off -= r.bank * ((D - (r.D - r.R)) / r.R);
    }
    return off;
  };
}
