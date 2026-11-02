// What each step's leg (the drive to that step) is part of, for colouring the list and the step bar:
//   timed    a timed zone (scored): an average speed applies
//   transit  a transit (untimed), or waiting between segments for a restart
//   rest     a transit with a stop in it: a covered bridge, scenic stop, rest, lunch
//   untimed  no average speed yet (before the first CAST, outside any transit)
import { zoneEdge } from './instruction.js';

const REST_RE = /\b(covered\s+bridge|scenic|rest\s*(?:stop|area|zone)?|lunch|break|photo|picnic|overlook)\b/i;
const EPS = 1e-3;

// rows: the schedule's rows in order; sch: the schedule (inTransit, waitingAt, castAt).
// Returns Map n -> { zone, cast (the CAST on the leg to this step, timed only), castSet (a CAST this step sets),
// zoneStart (the first step of a new zone kind) }.
export function zoneKinds(rows, sch) {
  const out = new Map(), stretches = [];
  let lastD = 0, stretch = null;
  for (const r of rows) {
    const D = r.D ?? lastD;
    if (r.D !== null && r.D !== undefined) lastD = r.D;
    const legD = Math.max(0, D - EPS);
    const untimedLeg = sch.inTransit(legD) || sch.waitingAt(legD);
    const cast = sch.castAt(legD);
    const zone = untimedLeg ? 'transit' : cast > 0 ? 'timed' : 'untimed';
    // A transit's steps, from the first one driven in it to the end of the transit (its ETZ step).
    if (zone === 'transit') { if (!stretch) { stretch = []; stretches.push(stretch); } stretch.push(r.n); } else stretch = null;
    out.set(r.n, { zone, cast: zone === 'timed' ? cast : null, castSet: r.cast_mph > 0 ? r.cast_mph : null, zoneStart: false });
    // An ETZ step is the last of its transit: the steps after it are a new stretch.
    if (r.zone === 'transit' && zoneEdge(r) === 'end') stretch = null;
  }
  // A transit with a covered bridge, scenic stop, rest or lunch in it is a rest zone.
  const text = (r) => `${r.text ?? ''} ${r.note ?? ''} ${r.landmark ?? ''}`;
  const byN = new Map(rows.map((r) => [r.n, r]));
  for (const s of stretches) if (s.some((n) => REST_RE.test(text(byN.get(n))))) for (const n of s) out.get(n).zone = 'rest';
  let last = null;
  for (const r of rows) { const z = out.get(r.n); z.zoneStart = z.zone !== last; last = z.zone; }
  return out;
}
