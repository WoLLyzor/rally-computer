// Perfect-time engine (design §6.5 Plan, §7 Timing; rally_guide §6–§7).
// Route coordinate D = cumulative official miles from the rally start, chained across /0.00 sections.
// Perfect time T(D) is piecewise linear: CAST segments, plus jumps at pauses, gains, TAs and restarts.

import { parseTod, assignSections, zoneEdge } from './instruction.js';

export const secPerMile = (mph) => 3600 / mph;

// Assign D to every instruction that has an OM (D = section base + om). A "/0.00" row starts a new
// section whose base is that row's D. Rows without an OM take D from a live mark, then a map pin;
// otherwise D stays null (pending) and its timing events wait until it is resolved.
export function resolveRoute(instructions, { marks = {}, pins = {} } = {}) {
  const rows = [...instructions].sort((a, b) => a.n - b.n).map((r) => ({ ...r }));
  if (!rows.some((r) => r.section > 1)) assignSections(rows);
  const bases = { 1: 0 };
  let curSection = rows.length ? rows[0].section : 1;
  for (const r of rows) {
    if (r.section !== curSection) curSection = r.section;
    const base = bases[r.section];
    if (r.om !== null && r.om !== undefined && base !== undefined && base !== null) r.D = base + r.om;
    else if (marks[r.n] !== undefined) r.D = marks[r.n];
    else if (pins[r.n] !== undefined) r.D = pins[r.n];
    else r.D = null;
    r.Dsrc = r.om !== null && base !== undefined && base !== null ? 'om' : marks[r.n] !== undefined ? 'mark' : pins[r.n] !== undefined ? 'pin' : null;
    if (r.reset_odo || r.action === 'zero_odo') bases[r.section + 1] = r.D;   // null if the reset point is unknown
  }
  return { rows, bases };
}

// Event phases at the same D: arrival-type first, then absolute restarts, then jumps, then slope.
const PHASE = { control: 0, transit_end: 1, restart: 1, pause: 2, gain: 2, ta: 2, cast: 3, transit_start: 4, free_start: 5, free_end: 5 };

// opts: { startTod (s of day at startD), startD = 0, carNumber = 0,
//         live: { outTimes: {n: tod}, inTimes: {n: tod}, tas: [{D, s}] } }
export function buildSchedule(instructions, opts = {}) {
  const { startD = 0, carNumber = 0, marks = {}, pins = {} } = opts;
  const startTod = typeof opts.startTod === 'string' ? parseTod(opts.startTod) : opts.startTod ?? null;
  const live = { outTimes: {}, inTimes: {}, tas: [], ...(opts.live || {}) };
  const { rows, bases } = resolveRoute(instructions, { marks, pins });

  const events = [];
  const pending = [];
  for (const r of rows) {
    if (r.D === null) { if (hasTimingEffect(r)) pending.push(r.n); continue; }
    const push = (kind, extra = {}) => events.push({ D: r.D, n: r.n, kind, phase: PHASE[kind], ...extra });
    if (r.action === 'control' && (r.control === 'open' || r.control === 'diyc')) push('control', { control: r.control });
    const edge = zoneEdge(r);
    if (r.zone === 'transit' && edge === 'end') push('transit_end', { transit_s: r.transit_s });
    if (r.restart_tod) {
      let tod = parseTod(r.restart_tod);
      if (r.restart_plus_car) tod += 60 * carNumber;
      push('restart', { tod });
    }
    if (r.pause_s > 0) push('pause', { s: r.pause_s });
    if (r.gain_s > 0) push('gain', { s: r.gain_s });
    if (r.cast_mph > 0) push('cast', { mph: r.cast_mph });
    if (r.zone === 'transit' && edge === 'start') push('transit_start', { transit_s: r.transit_s });
    if (r.zone === 'free' && edge === 'start') push('free_start');
    if (r.zone === 'free' && edge === 'end') push('free_end');
  }
  for (const ta of live.tas || []) events.push({ D: ta.D, n: ta.n ?? Infinity, kind: 'ta', phase: PHASE.ta, s: ta.s });
  for (const rs of live.restarts || []) events.push({ D: rs.D, n: rs.n ?? Infinity, kind: 'restart', phase: PHASE.restart, tod: parseTod(rs.tod) });
  // Same point: instructions in numeric order (Art 23.A.2), then the phases within one instruction.
  events.sort((a, b) => a.D - b.D || a.n - b.n || a.phase - b.phase);

  // Walk. State: perfect time T0 at D0, slope from mph. T0 null = unknown (no CAST yet / open transit).
  let D0 = startD, T0 = startTod, mph = null, transit = false, transitStart = null, transitAllow = null, free = false;
  const bps = [{ D: D0, T: T0, mph, transit, free, kind: 'start', n: 0 }];
  const perN = {};
  const controls = [];
  const advance = (D) => {
    if (D < D0 - 1e-9) throw new Error(`event at D=${D} before D0=${D0}`);
    if (!transit && T0 !== null) {
      if (mph !== null) T0 = T0 + (D - D0) * 3600 / mph;
      else if (D > D0 + 1e-9) T0 = null;                       // distance covered with no CAST: time unknown
    }
    D0 = D;
  };
  for (const e of events) {
    advance(e.D);
    const before = transit ? null : T0;
    switch (e.kind) {
      case 'cast': mph = e.mph; break;
      case 'pause': if (!transit && T0 !== null) T0 += e.s; break;
      case 'gain': if (!transit && T0 !== null) T0 -= e.s; break;
      case 'ta': if (T0 !== null) T0 += e.s; break;
      case 'restart': T0 = e.tod; transit = false; break;
      case 'transit_start':
        transitStart = T0; transitAllow = e.transit_s ?? null; transit = true; break;
      case 'transit_end': {
        const allow = e.transit_s ?? transitAllow;
        transit = false;
        T0 = transitStart !== null && allow !== null ? transitStart + allow : null;   // a restart at the same row overrides
        break;
      }
      case 'control': {
        const tin = live.inTimes[e.n] !== undefined ? parseTod(live.inTimes[e.n]) : before;
        let tout;
        if (live.outTimes[e.n] !== undefined) tout = parseTod(live.outTimes[e.n]);
        else tout = tin === null ? null : tin + 120;   // open: provisional until the crew's out time is entered; DIYC: exactly 2.00 min
        controls.push({ n: e.n, D: e.D, control: e.control, T_in_perfect: before, T_in: tin, T_out: tout, out_entered: live.outTimes[e.n] !== undefined });
        T0 = tout;
        break;
      }
      case 'free_start': free = true; break;
      case 'free_end': free = false; break;
    }
    bps.push({ D: D0, T: transit ? null : T0, mph, transit, free, kind: e.kind, n: e.n });
    if (Number.isFinite(e.n)) {
      const p = perN[e.n] || (perN[e.n] = { n: e.n, D: e.D, T_arrive: before, T_leave: null });
      p.T_leave = transit ? null : T0;
    }
  }

  const findBp = (D) => {
    // last breakpoint with bp.D <= D (after all events at that D)
    let lo = 0, hi = bps.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bps[mid].D <= D + 1e-9) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return bps[ans];
  };

  const schedule = {
    rows, bases, events, breakpoints: bps, controls, pending,
    // Perfect time of day at route distance D, or null (no CAST yet, inside a transit zone, unknown restart).
    perfectTimeAt(D) {
      if (D < startD - 1e-9) return null;
      const bp = findBp(D);
      if (bp.transit || bp.T === null || bp.mph === null) return D === bp.D ? bp.T : null;
      return bp.T + (D - bp.D) * 3600 / bp.mph;
    },
    // Arrival (before any jump) at D: the time a control or pause point should be reached.
    arrivalAt(D) {
      const idx = bps.findIndex((b) => b.D >= D - 1e-9);
      if (idx <= 0) return schedule.perfectTimeAt(D);
      const prev = bps[idx - 1];
      if (prev.transit || prev.T === null || prev.mph === null) return null;
      return prev.T + (D - prev.D) * 3600 / prev.mph;
    },
    castAt(D) { return findBp(D).mph; },
    inTransit(D) { return findBp(D).transit; },
    inFreeZone(D) { return findBp(D).free; },
    // Inverse: where the car should be at time t (perfect position), or null.
    perfectDistanceAt(t) {
      for (let i = bps.length - 1; i >= 0; i--) {
        const b = bps[i];
        if (b.T === null || b.transit || b.mph === null) continue;
        if (t >= b.T - 1e-9) {
          const D = b.D + (t - b.T) * b.mph / 3600;
          const next = bps[i + 1];
          return next && D > next.D ? next.D : D;   // waiting out a pause/restart at the point
        }
      }
      return null;
    },
    // Per-instruction table for the navigator list and the printable backup.
    table() {
      return rows.map((r) => {
        const p = perN[r.n];
        const T_arrive = r.D === null ? null : p ? p.T_arrive : schedule.perfectTimeAt(r.D);
        return { n: r.n, section: r.section, om: r.om, D: r.D, Dsrc: r.Dsrc, cast: r.D === null ? null : schedule.castAt(r.D),
          T_arrive, T_leave: p ? p.T_leave : T_arrive };
      });
    },
  };
  return schedule;
}

function hasTimingEffect(r) {
  return r.cast_mph > 0 || r.pause_s > 0 || r.gain_s > 0 || r.restart_tod || r.action === 'control' || r.zone === 'transit';
}

// Delta in seconds: positive = late (design §7: delta = now − perfect time at the current distance).
export function deltaAt(schedule, D, nowTod) {
  const p = schedule.perfectTimeAt(D);
  return p === null ? null : nowTod - p;
}

// Start time of day for a car: base + car number minutes (rally_guide §5: 11:00 + car number).
export function carStartTod(baseTod, carNumber) {
  return (typeof baseTod === 'string' ? parseTod(baseTod) : baseTod) + 60 * carNumber;
}

// Richta Competitor's time allowance (Milwaukee SCCA and PCA guides; Alcan setup sheet): TA+ steps the
// leg's running total 0:10, 0:20, 0:30, then a minute more per press (1:30, 2:30 …) up to the event's
// maximum (19:30 in those guides, 9:30 at Alcan); TA− steps back down.
export function richtaLadder(maxS = 1170) {
  const L = [10, 20, 30];
  for (let s = 90; s <= maxS; s += 60) L.push(s);
  return L.filter((s) => s <= maxS);
}
// Richta button presses from one leg total to another (+ TA+, − TA−); null when either is off the ladder.
export function taPresses(fromS, toS, ladder) {
  const at = (s) => (s === 0 ? -1 : ladder.indexOf(s));
  const i = at(fromS), j = at(toS);
  return (fromS !== 0 && i < 0) || (toS !== 0 && j < 0) ? null : j - i;
}

// Time Allowance recommendation (§7 Speed advisor; rally_guide §6 TA). TAs come in stepS increments
// (default 30 s), or as totals on a ladder (Richta) starting from the leg's currentS. Picks the TA that
// leaves the smallest residual that can be fixed legally within withinMi: a late residual must be
// recoverable at the capped speed, an early one by easing off; otherwise the next one up (then wait).
export function recommendTA({ deltaS, offsetS = 0, castMph, capMph, stepS = 30, withinMi = 1.0, minMph = null, ladder = null, currentS = 0 }) {
  const behind = deltaS - offsetS;
  if (!(castMph > 0) || !(behind > 0)) return null;
  const gainPerMi = capMph > castMph ? 3600 / castMph - 3600 / capMph : 0;
  if (behind <= gainPerMi * withinMi) return null;   // recoverable without a TA
  const slow = minMph ?? Math.max(castMph - 10, castMph * 0.75);
  const losePerMi = 3600 / slow - 3600 / castMph;
  const adds = [];
  if (ladder) for (const T of ladder) { if (T > currentS) adds.push(T - currentS); }
  else for (let k = Math.max(1, Math.floor(behind / stepS)); k <= Math.ceil(behind / stepS) + 1; k++) adds.push(k * stepS);
  if (!adds.length) return null;   // already at the maximum
  const options = [];
  for (const ta of adds) {
    const residual = behind - ta;      // >0 still late, <0 early
    const ok = residual >= 0 ? residual <= gainPerMi * withinMi : -residual <= losePerMi * withinMi;
    if (ok) options.push({ taS: ta, residualS: residual });
  }
  if (!options.length) { const ta = adds.find((a) => a >= behind) ?? adds[adds.length - 1]; options.push({ taS: ta, residualS: behind - ta }); }
  options.sort((a, b) => Math.abs(a.residualS) - Math.abs(b.residualS) || a.residualS - b.residualS);
  const best = options[0];
  return ladder ? { ...best, totalS: currentS + best.taS, presses: taPresses(currentS, currentS + best.taS, ladder) } : best;
}
