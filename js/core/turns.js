// Turn detection and route progress (design v0 §7 re-sync and missed turn; v1 §8.3 re-sync events).
// Yaw rate comes from the RaceBox gyro (ImuFrame.yawRate) or, without a gyro, from GNSS heading.
// Convention: positive yaw = left (counter-clockwise from above).

export class TurnDetector {
  constructor({ rateOnDps = 6, minAngleDeg = 20, maxDurS = 8, quietS = 0.6, movingMps = 0.5 } = {}) {
    Object.assign(this, { rateOnDps, minAngleDeg, maxDurS, quietS, movingMps });
    this.seg = null; this.lastT = null; this.lastS = null; this.sign = 1; this.votes = 0;
  }
  // t (s), yawDps, s (raw m). Returns a turn event when a turning segment ends, else null.
  // Quiet time, duration and the angle count only while moving, so stopping partway through a turn
  // (stop sign, T, waiting for a gap) neither splits it into two small turns nor adds gyro drift.
  push(t, yawDps, s) {
    const dt = this.lastT === null ? 0 : Math.max(0, Math.min(2, t - this.lastT));
    const moving = this.lastS === null || dt === 0 || (s - this.lastS) / dt >= this.movingMps;
    this.lastT = t; this.lastS = s;
    const w = yawDps * this.sign;
    const turning = Math.abs(w) >= this.rateOnDps;
    let ev = null;
    if (turning) {
      if (this.seg && Math.sign(w) !== this.seg.dirSign && Math.abs(this.seg.psi) > 5) ev = this.close();
      if (!this.seg) this.seg = { t0: t, psi: 0, dirSign: Math.sign(w), pts: [], quietSince: null, quiet: 0, dur: 0 };
      this.seg.quietSince = null; this.seg.quiet = 0;
    } else if (this.seg) {
      if (this.seg.quietSince === null) this.seg.quietSince = t;
      if (moving) this.seg.quiet += dt;
      if (this.seg.quiet >= this.quietS) return this.close();
    }
    if (this.seg && (moving || turning)) { this.seg.dur += dt; this.seg.psi += w * dt; this.seg.pts.push({ t, psi: this.seg.psi, s }); }
    return ev;
  }
  close() {
    const g = this.seg; this.seg = null;
    if (!g || !g.pts.length) return null;
    const end = g.quietSince ?? g.pts[g.pts.length - 1].t;
    const dur = g.dur - g.quiet;
    const angle = g.psi;
    if (Math.abs(angle) < this.minAngleDeg || dur > this.maxDurS) return null;
    const half = angle / 2;
    let mid = g.pts[0];
    for (const p of g.pts) { if (Math.abs(p.psi) >= Math.abs(half)) { mid = p; break; } }
    return { t0: g.t0, t1: end, tMid: mid.t, sMid: mid.s, angle, dir: angle > 0 ? 'L' : 'R', dur };
  }
  // GNSS heading change across a detected turn (clockwise positive) checks the gyro sign.
  checkSign(ev, dHeadingDeg) {
    if (Math.abs(dHeadingDeg) < 45 || Math.abs(ev.angle) < 45) return;
    const agrees = Math.sign(dHeadingDeg) === -Math.sign(ev.angle);
    this.votes += agrees ? 1 : -1;
    if (this.votes <= -2) { this.sign *= -1; this.votes = 0; }
    this.votes = Math.max(-2, Math.min(3, this.votes));
  }
}

const TURN_MIN_ANGLE = { L: 60, R: 60, BL: 20, BR: 20, U: 120 };

// Tracks the next instruction, matches turns to exact-mileage instructions, and raises "Missed turn?".
// rows: instructions resolved to route miles D (timing.resolveRoute), sorted by n.
export class RouteProgress {
  constructor(rows, { windowMi = 0.05, missMi = 0.05, calibrated = false } = {}) {
    this.rows = rows; this.windowMi = windowMi; this.missMi = missMi; this.calibrated = calibrated;
    this.idx = 0; this.done = new Set(); this.alert = null; this.events = [];
  }
  setRows(rows) { this.rows = rows; }
  get next() { return this.rows[this.idx] ?? null; }
  exact(r) { return r.Dsrc === 'om' && r.om_decimals >= 2; }
  // Before the odometer check is calibrated, distance can be a few percent off: widen to ±3%.
  win(r) { return this.calibrated ? this.windowMi : Math.max(this.windowMi, 0.03 * (r.D ?? 0)); }

  // A detected turn at route mileage D (from the engine at the turn's midpoint).
  onTurn(ev, D) {
    for (let i = this.idx; i < Math.min(this.rows.length, this.idx + 4); i++) {
      const r = this.rows[i];
      if (r.action !== 'turn' || !r.dir || r.dir === 'S' || r.D === null) continue;
      const okDir = r.dir[r.dir.length - 1] === ev.dir || r.dir === 'U';
      if (!okDir || Math.abs(ev.angle) < (TURN_MIN_ANGLE[r.dir] ?? 60)) continue;
      if (Math.abs(D - r.D) > this.win(r) + (this.exact(r) ? 0 : 0.1)) continue;
      for (let j = this.idx; j <= i; j++) this.done.add(this.rows[j].n);
      this.idx = i + 1;
      if (this.alert?.n === r.n) this.alert = null;
      this.events.push({ kind: 'turn_matched', n: r.n, D, residual: r.D - D });
      return { row: r, resync: this.exact(r) ? { D_obs: r.D, s_obs: ev.sMid, sigmaMi: 0.006, label: `#${r.n} turn` } : null };
    }
    if (Math.abs(ev.angle) >= 60) this.events.push({ kind: 'turn_unmatched', D, dir: ev.dir, angle: ev.angle });
    return { row: null, resync: null };
  }

  // MARK: the car is at the next instruction's point now. Rows with an exact OM re-sync; rows without
  // a mileage (sign-referenced CASTs, pauses) get their route mileage from the mark.
  onMark(D, s) {
    let best = null;
    const nextRow = this.rows[this.idx];
    if (nextRow && nextRow.D === null) best = { r: nextRow, d: 0 };   // sign-referenced: marked when seen
    else {
      // the nearest row with a mileage within 0.1 mi, including the one just passed
      for (const r of this.rows.slice(Math.max(0, this.idx - 1), this.idx + 3)) {
        if (r.D === null) continue;
        const d = Math.abs(r.D - D);
        if (d <= 0.1 && (!best || d < best.d)) best = { r, d };
      }
    }
    if (!best) return { row: null };
    const r = best.r;
    const i = this.rows.indexOf(r);
    for (let j = this.idx; j <= i; j++) this.done.add(this.rows[j].n);
    this.idx = Math.max(this.idx, i + 1);
    if (r.D === null) return { row: r, markD: D };
    return { row: r, resync: this.exact(r) ? { D_obs: r.D, s_obs: s, sigmaMi: 0.008, label: `#${r.n} mark` } : null };
  }

  // The app was paused while the car moved: rows up to D were passed unseen, so no "Missed turn?" for them.
  passGap(D) {
    while (this.idx < this.rows.length) {
      const r = this.rows[this.idx];
      const at = r.D ?? this.rows.slice(this.idx + 1).find((x) => x.D !== null)?.D ?? Infinity;
      if (at > D) break;
      this.done.add(r.n); this.events.push({ kind: 'passed_in_gap', n: r.n }); this.idx++;
    }
    this.alert = null;
  }

  // After a pause the car is somewhere between D + eLo and D + eHi. A detected turn re-anchors only
  // when exactly one exact-mileage turn instruction of that direction lies in that range.
  matchAfterGap(ev, D, { eLo, eHi }) {
    const fits = [];
    for (let i = this.idx; i < this.rows.length; i++) {
      const r = this.rows[i];
      if (r.D === null) continue;
      if (r.D > D + eHi + 0.02) break;
      if (r.D < D + eLo - 0.02 || r.action !== 'turn' || !r.dir || r.dir === 'S' || !this.exact(r)) continue;
      const okDir = r.dir[r.dir.length - 1] === ev.dir || r.dir === 'U';
      if (okDir && Math.abs(ev.angle) >= (TURN_MIN_ANGLE[r.dir] ?? 60)) fits.push(i);
    }
    if (fits.length !== 1) return { row: null, fits: fits.map((i) => this.rows[i].n) };
    const i = fits[0], r = this.rows[i];
    for (let j = this.idx; j <= i; j++) this.done.add(this.rows[j].n);
    this.idx = i + 1; this.alert = null;
    this.events.push({ kind: 'turn_matched', n: r.n, D, residual: r.D - D, afterGap: true });
    return { row: r, fits: [r.n] };
  }

  jump(n) {
    const i = this.rows.findIndex((r) => r.n === n);
    if (i < 0) return;
    for (let j = 0; j < i; j++) this.done.add(this.rows[j].n);
    for (let j = i; j < this.rows.length; j++) this.done.delete(this.rows[j].n);   // set back: the lines ahead aren't done
    this.idx = i; this.alert = null;
  }

  // Advance past rows reached by distance; raise "Missed turn?" 0.05 mi past an unmatched exact turn.
  update(D) {
    while (this.idx < this.rows.length) {
      const r = this.rows[this.idx];
      if (r.D === null) {
        const after = this.rows.slice(this.idx + 1).find((x) => x.D !== null);
        if (after && D > after.D + 0.02) { this.events.push({ kind: 'skipped_unmarked', n: r.n }); this.idx++; continue; }
        break;
      }
      const isTurn = r.action === 'turn' && r.dir && r.dir !== 'S';
      if (isTurn && this.exact(r)) {
        if (D > r.D + this.missMi + (this.win(r) - this.windowMi)) {
          if (!this.alert) { this.alert = { kind: 'missed_turn', n: r.n, D: r.D }; this.events.push({ kind: 'missed_turn', n: r.n, D }); }
          this.idx++;
          continue;
        }
        break;
      }
      if (D >= r.D - 0.005) { this.done.add(r.n); this.idx++; continue; }
      break;
    }
    return { next: this.next, alert: this.alert };
  }
  clearAlert() { this.alert = null; }
}
