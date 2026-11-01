// Live loop: sensors → distance engine → route progress → perfect time → speed advice → voice.
// Produces the LiveState for the driver and navigator screens about 10 times a second and saves a
// crash-safe snapshot every second (design §7; A9).

import { DistanceEngine, ImuFrame, ImuQuiet, haversine } from '../core/fusion.js';
import { TurnDetector, RouteProgress } from '../core/turns.js';
import { buildSchedule, recommendTA, carStartTod } from '../core/timing.js';
import { targetSpeed, capFor, SpeedAnnouncer, LimitTracker } from '../core/speed.js';
import { buildDelays, plannedOffsetFn, slowdownLossS } from '../core/plan.js';
import { fmtTod, zoneEdge } from '../core/instruction.js';
import { instructionPhrase } from './voice.js';

const wrap180 = (d) => ((d + 540) % 360) - 180;

export class LiveLoop {
  constructor({ settings, clock, voice, onLog = () => {} }) {
    Object.assign(this, { settings, clock, voice, onLog });
    this.engine = new DistanceEngine({ obdLagS: settings.obdLagS });
    this.imu = new ImuFrame();
    this.quiet = new ImuQuiet();
    this.turns = new TurnDetector();
    this.limits = new LimitTracker();
    this.ann = new SpeedAnnouncer();
    this.ev = { marks: {}, outTimes: {}, inTimes: {}, tas: [], restarts: [] };
    this.instructions = []; this.schedule = null; this.progress = null;
    this.started = false; this.startS = 0; this.calibratedAt = null;
    this.offStart = null; this.undo = [];
    this.headings = []; this.prevRb = null; this.gnssAccel = 0;
    this.lastFix = null; this.pendingGap = null;
    this.spokenSpeed = null; this.offSince = null; this.pauseTaken = new Set();
    this.log = [];
  }

  addLog(text, extra = {}) {
    const e = { t_s: this.clock.nowTod(), text, ...extra };
    this.log.push(e); if (this.log.length > 2000) this.log.shift();
    this.onLog(e);
  }

  // keepPlace: a line edited or checked during the drive keeps the place in the route; a new route starts over.
  setRoute(instructions, { keepPlace = false } = {}) {
    const keep = keepPlace && this.started && this.progress ? { n: this.progress.next?.n ?? null, done: [...this.progress.done] } : null;
    this.instructions = instructions; this.progress = null; this.rebuild();
    if (keep) {
      const i = this.schedule.rows.findIndex((r) => r.n === keep.n);
      this.progress.idx = i >= 0 ? i : this.schedule.rows.length;
      this.progress.done = new Set(keep.done);
      this.progress.calibrated = this.engine.calibrated;
    }
  }

  rebuild() {
    const st = this.settings;
    this.schedule = buildSchedule(this.instructions, { startTod: carStartTod(st.baseStart, st.carNumber), carNumber: st.carNumber, marks: this.ev.marks, live: this.ev });
    const rows = this.schedule.rows;
    if (!this.progress) this.progress = new RouteProgress(rows); else this.progress.setRows(rows);
    const castAt = (D) => this.schedule.castAt(D);
    const capAt = (D) => capFor({ castMph: castAt(D), limitMph: null, defaultLimit: st.defaultLimit });
    this.delays = buildDelays(rows, { castAt });
    this.offsetFn = plannedOffsetFn(this.delays, { alpha: st.alpha, castAt, capAt });
  }

  // ---- sensors ----
  ingest(sm) {
    if (sm.src === 'racebox') {
      const p = this.prevRb, Dbefore = this.engine.D;
      if (!sm.late) this.clock.onGpsTime(sm.utc_ms, sm.timeResolved);
      if (this.prevRb && sm.fixOk && this.prevRb.fixOk) {
        const dt = sm.t - this.prevRb.t;
        if (dt > 0) this.gnssAccel += (1 - Math.exp(-dt / 0.3)) * ((sm.speed_mps - this.prevRb.speed_mps) / dt - this.gnssAccel);
      }
      this.prevRb = sm;
      const yaw = this.imu.yawRate(sm.gyro_dps);
      const aF = this.imu.push(sm.acc_g, { gnssAccel: this.gnssAccel, yawRate: yaw ?? 0 });
      if (aF !== null) sm.aFwd_mps2 = aF;
      sm.imuQuiet = this.quiet.push(sm.acc_g, sm.gyro_dps);
      this.engine.ingest(sm);
      // No data for a while (app paused, Bluetooth dropout) while the car was moving: the engine has
      // filled the gap from the GPS straight line; say how uncertain that is.
      if (p && this.started) {
        const gapS = Math.max(sm.t - p.t, sm.utc_ms && p.utc_ms ? (sm.utc_ms - p.utc_ms) / 1000 : 0);
        if (gapS > 2) this.enterRecovery(gapS, this.engine.D - Dbefore, Math.max(p.speed_mps, sm.speed_mps));
      }
      if (sm.headingValid && sm.speed_mps > 3) this.pushHeading(sm.t, sm.heading_deg);
      if (yaw !== null) { const ev = this.turns.push(sm.t, yaw, this.engine.s); if (ev) this.onTurn(ev); }
      if (sm.fixOk) this.onFix(sm.lat, sm.lon, sm.t);
    } else if (sm.src === 'gps') {
      this.engine.ingest(sm);
      if (sm.acc_m < 30) this.onFix(sm.lat, sm.lon, sm.t);
      const rbLive = sm.t - this.engine.last.racebox < 2;
      if (!rbLive && sm.heading_deg !== null && sm.speed_mps > 3) {
        const prev = this.headings[this.headings.length - 1];
        this.pushHeading(sm.t, sm.heading_deg);
        if (prev) { const ev = this.turns.push(sm.t, -wrap180(sm.heading_deg - prev.h) / Math.max(0.2, sm.t - prev.t), this.engine.s); if (ev) this.onTurn(ev); }
      }
    } else if (sm.src === 'obd') this.engine.ingest(sm);
  }

  pushHeading(t, h) { this.headings.push({ t, h, D: this.engine.D }); while (this.headings.length && this.headings[0].t < t - 60) this.headings.shift(); }
  headingNear(t) { let best = null; for (const x of this.headings) if (!best || Math.abs(x.t - t) < Math.abs(best.t - t)) best = x; return best && Math.abs(best.t - t) < 1.5 ? best.h : null; }
  // GPS course change (clockwise positive) across a turn instruction's point, if it shows that turn.
  turnedAcross(r) {
    const before = this.headings.findLast((x) => x.D <= r.D - 0.03), after = this.headings[this.headings.length - 1];
    if (!before || !after || after.D < r.D + 0.02 || !r.dir) return null;
    const d = wrap180(after.h - before.h);
    if (r.dir === 'U') return Math.abs(d) >= 120 ? d : null;
    const ok = Math.sign(d) === (r.dir.endsWith('R') ? 1 : -1) && Math.abs(d) >= (r.dir.startsWith('B') ? 15 : 25);
    return ok ? d : null;
  }

  onFix(lat, lon, t) {
    if (this.pendingGap) {   // first fix after a restart: bound the distance driven while the app was down
      const g = this.pendingGap; this.pendingGap = null;
      const chord = haversine(g.lat, g.lon, lat, lon);
      const driven = this.engine.s - g.s;
      const fixed = Math.min(Math.max(driven, chord), chord * 1.05);
      this.engine.s = g.s + fixed;
      this.addLog(`Resumed: gap distance ${driven.toFixed(0)} m → ${fixed.toFixed(0)} m from GPS`);
      if (this.started && g.seconds) this.enterRecovery(g.seconds, fixed / 1609.344 * this.engine.K, Math.max(g.v ?? 0, this.engine.v));
    }
    this.lastFix = { lat, lon, t };
  }

  // The app was paused (Home button, screen off, restart) while the car moved. The gap was filled from
  // the GPS straight line, which is short when the road bent: the car may be up to eHi miles further.
  // Rows passed meanwhile raise no alarm. The next turn that only one instruction fits re-anchors the
  // distance, or the navigator taps the instruction they're at. Small gaps need none of this.
  enterRecovery(gapS, fillMi, vMax) {
    const e = this.engine, prev = this.recover;
    const eHi = Math.max(0, (vMax * 1.15 * gapS + 30) / 1609.344 * (e.K || 1) - fillMi) + (prev?.eHi ?? 0);
    const eLo = -0.05 * Math.max(0, fillMi) - 0.01 + (prev ? prev.eLo + 0.01 : 0);
    if (eHi - eLo <= 0.06 || !this.progress) return;
    this.progress.passGap(e.D);
    this.recover = { gapS: Math.round(gapS), eLo, eHi };
    this.addLog(`Paused ${gapS.toFixed(0)} s while moving: filled ${fillMi.toFixed(2)} mi from GPS; the car may be up to ${eHi.toFixed(2)} mi further. Fixing at the next turn, or tap the instruction you're at.`);
    this.voice?.speak('The app was paused. Distance may be off until the next turn.', { key: `paused:${Math.round(e.s)}`, alert: true });
  }

  onTurn(ev) {
    const h0 = this.headingNear(ev.t0 - 1), h1 = this.headingNear(ev.t1 + 1);
    if (h0 !== null && h1 !== null) this.turns.checkSign(ev, wrap180(h1 - h0));
    if (!this.started) return;
    const D = this.engine.Dof(ev.sMid);
    if (this.recover) {
      const m = this.progress.matchAfterGap(ev, D, this.recover);
      if (!m.row) {
        this.addLog(`Turn ${ev.dir} ${Math.abs(ev.angle).toFixed(0)}° after the pause ${m.fits.length ? `fits #${m.fits.join(' and #')}` : 'fits no instruction'}: distance still uncertain`);
        return;
      }
      const jump = this.engine.reanchor(m.row.D, ev.sMid, `#${m.row.n} turn after pause`);
      this.recover = null;
      this.lastResync = `#${m.row.n} after pause ${jump >= 0 ? '+' : ''}${jump.toFixed(3)} mi`;
      this.addLog(`Back on track: turn ${ev.dir} matched #${m.row.n}; distance ${jump >= 0 ? '+' : ''}${jump.toFixed(3)} mi`);
      this.voice?.speak(`Distance fixed at instruction ${m.row.n}.`, { key: `fixed:${m.row.n}` });
      return;
    }
    const res = this.progress.onTurn(ev, D);
    if (res.row) this.addLog(`Turn ${ev.dir} ${Math.abs(ev.angle).toFixed(0)}° matched #${res.row.n} at ${D.toFixed(3)}`);
    if (res.resync && this.engine.calibrated) {
      const r = this.engine.resync(res.resync);
      this.addLog(r.accepted ? `Re-sync #${res.row.n}: ${r.residual >= 0 ? '+' : ''}${r.residual.toFixed(3)} mi` : `Re-sync #${res.row.n} rejected (${r.residual.toFixed(3)} mi off) — tap MARK at the next exact point`);
      this.lastResync = `#${res.row.n} ${r.residual >= 0 ? '+' : ''}${r.residual.toFixed(3)} mi${r.accepted ? '' : ' (rejected)'}`;
    }
  }

  // ---- navigator / driver actions ----
  action(name, p = {}) {
    const e = this.engine;
    const sNow = e.sAt((e.t ?? 0) - 0.3);   // human reaction ≈ 0.3 s
    switch (name) {
      case 'start':
        if (this.started && !p.force) { this.addLog('START ignored: the rally is already running (Reset rally state on Home to start over)'); break; }
        e.zero(0); this.started = true; this.startS = e.s;
        this.progress.jump(this.schedule.rows[0]?.n ?? 1);
        this.addLog(`Start at ${fmtTod(this.clock.nowTod())}`);
        break;
      case 'mark': {
        if (!this.started) { this.action('start'); break; }
        const D = e.Dof(sNow);
        const since = this.lastMarkD === undefined ? '' : ` (Δ ${(D - this.lastMarkD).toFixed(3)} mi since last MARK)`;
        this.lastMarkD = D;
        const res = this.progress.onMark(D, sNow);
        if (!res.row) { this.addLog(`MARK at ${D.toFixed(3)}${since}: no instruction within 0.1 mi`); break; }
        if (res.markD !== undefined) {
          this.undo.push({ kind: 'mark', n: res.row.n });
          this.ev.marks[res.row.n] = res.markD; this.rebuild();
          this.addLog(`MARK #${res.row.n} at ${res.markD.toFixed(3)}`);
        } else if (res.row.odo_check_end && !e.calibrated) {
          this.calibrateAt(res.row, sNow);
        } else if (res.resync && e.calibrated) {
          const r = e.resync(res.resync);
          this.lastResync = `#${res.row.n} mark ${r.residual >= 0 ? '+' : ''}${r.residual.toFixed(3)} mi${r.accepted ? '' : ' (rejected)'}`;
          this.addLog(`MARK #${res.row.n}: ${this.lastResync}`);
        } else this.addLog(`MARK #${res.row.n}`);
        break;
      }
      case 'odo_end': {
        const row = this.schedule.rows.find((r) => r.odo_check_end && r.D !== null) ?? this.schedule.rows.find((r) => (r.reset_odo || r.action === 'zero_odo') && r.D !== null);
        if (!row) { this.addLog('End of odometer check: no instruction marks it; enter it in the route'); break; }
        this.calibrateAt(row, sNow);
        break;
      }
      case 'limit': this.limits.setNav(p.mph, this.progress?.next?.n ?? null); this.addLog(`Limit ${p.mph}`); break;
      case 'checkpoint': {
        const tod = typeof p.tod === 'number' ? fmtTod(p.tod) : p.tod;
        const row = this.schedule.rows.find((r) => r.n === p.n);
        this.undo.push({ kind: 'checkpoint', n: p.n, which: p.kind });
        // Score the in-time against the perfect arrival (self-timed practice checkpoints, A8). A pause
        // at a stop is taken at the stop line, before the point, so there the car passes at the departure.
        let err = '';
        if (p.kind === 'in') {
          const D = row?.D ?? e.D;
          const perfect = row?.pause_s > 0 && (row.cue || this.pauseTaken.has(row.n)) ? this.schedule.perfectTimeAt(D) : this.schedule.arrivalAt(D);
          if (perfect !== null) {
            const d = (typeof p.tod === 'number' ? p.tod : this.clock.nowTod()) - perfect;
            err = ` · ${d >= 0 ? '+' : ''}${d.toFixed(1)} s vs perfect ${fmtTod(perfect)}`;
            this.cpErrors = [...(this.cpErrors || []), { n: p.n, D, err: d }];
          }
        }
        if (p.kind === 'out') this.ev.outTimes[p.n] = tod;
        else if (row?.control === 'diyc') this.ev.inTimes[p.n] = tod;
        this.rebuild();
        this.addLog(`Checkpoint #${p.n} ${p.kind} ${tod}${err}`, { claim: true });
        break;
      }
      case 'ta': this.ev.tas.push({ D: e.D, s: p.s }); this.undo.push({ kind: 'ta' }); this.rebuild(); this.addLog(`TA ${p.s / 60} min declared at ${e.D.toFixed(2)}`, { claim: true }); break;
      case 'restart': this.ev.restarts.push({ D: e.D, tod: typeof p.tod === 'number' ? fmtTod(p.tod) : p.tod }); this.undo.push({ kind: 'restart' }); this.rebuild(); this.addLog(`Restart ${p.tod}`); break;
      case 'jump': this.progress.jump(p.n); this.addLog(`Next instruction set to #${p.n}`); break;
      case 'here': {   // the navigator says the car is at instruction #n now (after a pause)
        const rows = this.schedule.rows, i = rows.findIndex((r) => r.n === p.n), row = rows[i];
        if (!this.started) break;
        if (!row || row.D === null) { this.addLog(`#${p.n} has no mileage: MARK it when you reach it`); break; }
        this.undo.push({ kind: 'here', theta: [...e.theta], Ptheta: e.Ptheta.map((x) => [...x]), idx: this.progress.idx, done: [...this.progress.done], recover: this.recover ?? null });
        const jump = e.reanchor(row.D, sNow, `#${row.n} navigator`);
        this.progress.jump(rows[i + 1]?.n ?? row.n); this.progress.done.add(row.n);
        this.recover = null;
        this.lastResync = `#${row.n} by navigator ${jump >= 0 ? '+' : ''}${jump.toFixed(3)} mi`;
        this.addLog(`At #${row.n} (navigator): distance ${jump >= 0 ? '+' : ''}${jump.toFixed(3)} mi`);
        break;
      }
      case 'offcourse':
        if (p.on && !this.offStart) { this.offStart = { s: e.s, D: e.D }; this.addLog(`Off course at ${e.D.toFixed(3)}`); }
        else if (!p.on && this.offStart) {
          const extra = e.s - this.offStart.s;
          e.s = this.offStart.s;       // back at the point where we left the route
          this.addLog(`Back on course: removed ${(extra / 1609.344).toFixed(2)} mi off-course distance`);
          this.offStart = null; this.progress.clearAlert();
        }
        break;
      case 'ack': this.progress.clearAlert(); break;
      case 'undo': {
        const u = this.undo.pop();
        if (!u) break;
        if (u.kind === 'ta') this.ev.tas.pop();
        if (u.kind === 'restart') this.ev.restarts.pop();
        if (u.kind === 'mark') delete this.ev.marks[u.n];
        if (u.kind === 'checkpoint') { if (u.which === 'out') delete this.ev.outTimes[u.n]; else delete this.ev.inTimes[u.n]; }
        if (u.kind === 'here') { e.theta = u.theta; e.Ptheta = u.Ptheta; this.progress.idx = u.idx; this.progress.done = new Set(u.done); this.recover = u.recover; }
        if (u.kind === 'calibrate') {
          Object.assign(e, { theta: u.theta, Ptheta: u.Ptheta, calibrated: u.calibrated });
          this.calibratedAt = u.calibratedAt; this.progress.idx = u.idx; this.progress.done = new Set(u.done); this.calWarn = null;
        }
        this.rebuild(); this.addLog(`Undo ${u.kind}`);
        break;
      }
      case 'clock_sync': { const ms = this.clock.syncToMinute(); this.addLog(`Clock synced to master (${(ms / 1000).toFixed(2)} s from ${this.clock.ref})`); break; }
    }
  }

  calibrateAt(row, sEnd) {
    const e = this.engine;
    const prev = { theta: [...e.theta], Ptheta: e.Ptheta.map((x) => [...x]), calibrated: e.calibrated, calibratedAt: this.calibratedAt, idx: this.progress.idx, done: [...this.progress.done] };
    const K = e.calibrate({ omStart: 0, sStart: this.startS, omEnd: row.D, sEnd });
    if (K === null) { this.addLog('Odometer check too short to calibrate'); return; }
    this.undo.push({ kind: 'calibrate', ...prev });
    this.calibratedAt = row.n;
    this.progress.jump(this.schedule.rows.find((r) => r.n > row.n)?.n ?? row.n);
    this.addLog(`Odometer check: factor ${K.toFixed(4)} (official ÷ measured) over ${row.D.toFixed(2)} mi`);
    // GPS distance and the rallymaster's odometer normally agree within a few percent; much more
    // usually means End odo check was tapped at the wrong place.
    if (Math.abs(K - 1) > 0.05) {
      this.calWarn = { K, until: performance.now() / 1000 + 90 };
      this.addLog(`Factor ${K.toFixed(3)} is ${((K - 1) * 100).toFixed(1)}% off: if End odo check was not tapped at #${row.n}'s point, Undo last takes it back`);
      this.voice?.speak('Check the odometer factor. It looks wrong.', { key: `calwarn:${row.n}:${Math.round(sEnd)}`, alert: true });
    } else this.calWarn = null;
  }

  // ---- 10 Hz state ----
  tick() {
    const st = this.settings, e = this.engine, sch = this.schedule;
    // Sensors drive the engine; if every source goes quiet, dead-reckon for up to 5 s, then hold.
    const tn = performance.now() / 1000;
    const lastSample = Math.max(e.last.racebox, e.last.obd, e.last.gps);
    if (e.t !== null && tn - e.t > 0.3 && tn - lastSample < 5) e.predict(tn);
    const now = this.clock.nowTod();
    const D = e.D;
    if (this.progress) this.progress.calibrated = e.calibrated;
    const pr = this.started ? this.progress.update(D) : { next: sch.rows[0] ?? null, alert: null };
    if (this.recover && pr.alert) { this.progress.clearAlert(); pr.alert = null; }   // the distance itself is in doubt
    // A turn the gyro missed (a gap in its data, an odd junction): the GPS course across the point
    // confirms it, so no false "Missed turn?".
    if (pr.alert && !pr.alert.checked) {
      pr.alert.checked = true;
      const r = sch.rows.find((x) => x.n === pr.alert.n), d = r ? this.turnedAcross(r) : null;
      if (d !== null) { this.progress.clearAlert(); pr.alert = null; this.addLog(`Turn #${r.n} confirmed by GPS course (${d > 0 ? '+' : ''}${d.toFixed(0)}°)`); }
    }
    const perfect = this.started ? sch.perfectTimeAt(D) : null;
    let delta = perfect === null ? null : now - perfect;
    const cast = this.started ? sch.castAt(D) : sch.castAt(0);
    // A pause taken at a stop. Near the point (−0.03…+0.015 mi, wider than the distance error) the time
    // to beat is the arrival until the car stops; stopped, the departure (arrival + pause) less half of
    // what pulling away costs, with "Go in N"; once taken, the departure line, also for the few metres
    // between the stop line and the point. Without a stop the pause applies just past the point.
    let hold = null;
    const pz = this.started ? sch.rows.find((r) => r.pause_s > 0 && r.D !== null && D >= r.D - 0.03 && D <= r.D + 0.015) : null;
    const pArrive = pz ? sch.arrivalAt(pz.D) : null, depart = pz ? sch.perfectTimeAt(pz.D) : null;
    if (pArrive !== null && depart !== null) {
      const cBefore = sch.castAt(pz.D - 1e-6), cAfter = sch.castAt(pz.D);
      if (e.v < 0.5 || (this.holdN === pz.n && e.v < 4)) {
        const goAt = depart - (st.alpha ?? 0.5) * slowdownLossS((cAfter ?? 0) * 0.44704, 0, { aDecel: Infinity });
        hold = { n: pz.n, go_tod: goAt, in_s: goAt - now, go: now >= goAt };
        delta = now - goAt;
        this.holdN = pz.n; this.pauseTaken.add(pz.n);
      } else {
        this.holdN = null;
        const taken = this.pauseTaken.has(pz.n), c = taken ? cAfter : cBefore;
        if (c > 0) delta = now - ((taken ? depart : pArrive) + (D - pz.D) * 3600 / c);
      }
    } else this.holdN = null;
    if (this.started && cast > 0 && e.v >= 0.7 * cast * 0.44704) this.cruiseSince ??= tn; else this.cruiseSince = null;
    const lim = this.limits.current({ mapMph: null, currentN: pr.next?.n ?? null });
    const offset = this.started ? this.offsetFn(D) : 0;
    const adv = targetSpeed({ deltaS: delta, offsetS: offset, castMph: cast, limitMph: lim.mph, defaultLimit: st.defaultLimit, horizonMi: st.horizonMi, horizonS: st.horizonS });
    const said = this.ann.update(now, adv);
    const transitRow = this.started && sch.inTransit(D) ? sch.rows.find((r) => r.D !== null && r.D > D && r.zone === 'transit' && zoneEdge(r) === 'end') : null;
    const arrive = transitRow ? sch.perfectTimeAt(transitRow.D) : null;
    const ta = delta !== null && adv ? recommendTA({ deltaS: delta, offsetS: offset, castMph: cast, capMph: adv.cap, stepS: st.taStep_s }) : null;
    const next = pr.next;
    const idx = next ? sch.rows.indexOf(next) : -1;
    const after = idx >= 0 ? sch.rows.slice(idx + 1, idx + 4) : [];
    const base = next ? (sch.bases[next.section] ?? 0) : 0;
    let alert = null;
    if (pr.alert) alert = { kind: 'missed_turn', text: `Missed turn? Check #${pr.alert.n} at ${fmtOm(pr.alert.D - (sch.bases[sch.rows.find((r) => r.n === pr.alert.n)?.section] ?? 0))}` };
    if (this.offStart) alert = { kind: 'offcourse', text: `Off course since ${fmtOm(this.offStart.D - base)} · ${((e.s - this.offStart.s) / 1609.344).toFixed(2)} mi` };
    else if (this.recover) alert = { kind: 'recovering', text: `Paused ${this.recover.gapS} s: distance may be up to ${this.recover.eHi.toFixed(2)} mi short. Tap the instruction you're at (or wait for the next turn).` };
    if (this.calWarn && tn < this.calWarn.until) alert = alert ?? { kind: 'calibration', text: `Odometer factor ${this.calWarn.K.toFixed(3)} looks wrong (${((this.calWarn.K - 1) * 100).toFixed(1)}% off). Tapped End odo check at the wrong place? Then Undo last.` };
    if (e.health.racebox === 'lost' && e.health.gps !== 'ok' && this.started) alert = alert ?? { kind: 'gps_lost', text: 'No GPS: distance is estimated' };

    this.cues({ D, next, delta, speak: said.speak, display: said.display, cap: adv?.cap ?? null, alert, hold });

    this.state = {
      t_s: now, d_om: D - base, D, section: next?.section ?? 1, delta_s: delta, perfect_t: perfect,
      target_mph: said.display, limit_mph: lim.mph ?? (adv ? null : null), limit_src: lim.src ?? (adv ? 'default' : null), cast_mph: cast,
      next: next ? { n: next.n, om: next.om, text: next.text, ins: next, to_mi: next.D !== null ? next.D - D : null } : null,
      after: after.map((r) => ({ n: r.n, om: r.om, text: r.text, ins: r })),
      zone: sch.inFreeZone(D) ? 'free' : transitRow ? 'transit' : null,
      transit: transitRow && arrive !== null ? { arrive_tod: arrive, remaining_s: arrive - now } : null,
      alert, hold, ta_suggest: ta && ta.taS > 0 ? ta : null,
      health: { ...e.health, k: e.K, last_resync: this.lastResync ?? '' },
      speed_mph: e.v / 0.44704, stopped: e.v < 0.3, unit: st.timingUnit, started: this.started, calibrated: e.calibrated,
      recovering: !!this.recover,
    };
    return this.state;
  }

  cues({ D, next, delta, speak, display, cap, alert, hold }) {
    const v = this.voice;
    if (!v || !this.started) return;
    if (alert && alert.kind === 'missed_turn') v.speak(`Check. Possible missed turn, instruction ${this.progress.alert.n}.`, { key: `miss:${this.progress.alert.n}`, alert: true });
    if (hold) {
      // Pause at a stop: a countdown instead of time and speed calls.
      if (hold.go) v.speak('Go.', { key: `go:${hold.n}`, alert: true });
      else {
        if (!v.said.has(`hold:${hold.n}`)) this.holdFrom = hold.in_s;
        v.speak(`Pause. Go in ${Math.round(hold.in_s)}.`, { key: `hold:${hold.n}` });
        if (hold.in_s <= 5 && this.holdFrom > 8) v.speak('Five.', { key: `five:${hold.n}` });
      }
      this.lastCall = null;
      return;
    }
    if (next) {
      const phrase = instructionPhrase(next);
      if (next.D === null) v.speak(`Next: ${phrase}. Mark it when you see it.`, { key: `next:${next.n}` });
      else {
        const to = next.D - D;
        if (to <= 0.3 && to > 0.15) v.speak(`In point three, ${phrase}.`, { key: `n3:${next.n}` });
        else if (to <= 0.1 && to > -0.02) v.speak(phrase, { key: `n1:${next.n}` });
      }
    }
    // Speed targets: on a change of 2 mph or more (at once if the cap drops below the last one said);
    // held while stopped or turning (under 8 mph) and said once the car is moving again.
    const moving = this.engine.v >= 8 * 0.44704;
    if (speak !== null && !moving) this.speedHeld = true;
    if (moving && display !== null && (speak !== null || this.speedHeld)
      && (this.spokenSpeed === null || Math.abs(display - this.spokenSpeed) >= 2 || (cap !== null && cap < this.spokenSpeed))) { v.speak(String(display)); this.spokenSpeed = display; }
    if (moving) this.speedHeld = false;
    // Time calls for the driver: "3 late" / "2 early" when off by 2 s or more, only while cruising (at
    // 70% of the CAST for 10 s, so never at a stop, a turn or pulling away), repeated only when the
    // error changes noticeably (or every 30 s), never over an instruction cue; "On time" once it's fixed.
    const now = performance.now() / 1000;
    const cruising = this.cruiseSince != null && now - this.cruiseSince >= 10;
    if (delta !== null && cruising && !this.schedule.inFreeZone(D)) {
      const a = Math.abs(delta), n = Math.round(a);
      const sinceCall = now - (this.lastCall?.t ?? -1e9);
      const sinceCue = now - (v.lastSpokeAt ?? -1e9);
      if (a >= 2 && sinceCue > 4) {
        const band = a >= 10 ? 3 : a >= 5 ? 2 : 1;
        const c = this.lastCall;
        const changed = !c || c.sign !== Math.sign(delta) || Math.abs(n - c.n) >= 2 || band > c.band;
        if ((changed && sinceCall > 8) || sinceCall > 30) {
          v.speak(`${n} ${delta > 0 ? 'late' : 'early'}`);
          this.lastCall = { t: now, n, sign: Math.sign(delta), band };
        }
      } else if (a <= 0.6 && this.lastCall?.n >= 2 && sinceCall > 3 && sinceCue > 2) {
        v.speak('On time.');
        this.lastCall = { t: now, n: 0, sign: 0, band: 0 };
      }
    }
  }

  // ---- crash-safe state ----
  snapshot() {
    return { v: 1, wallMs: Date.now(), engine: this.engine.snapshot(Date.now()), ev: this.ev, started: this.started, startS: this.startS,
      calibratedAt: this.calibratedAt, progress: this.progress ? { idx: this.progress.idx, done: [...this.progress.done] } : null,
      offStart: this.offStart, lastFix: this.lastFix ? { lat: this.lastFix.lat, lon: this.lastFix.lon } : null, said: [...(this.voice?.said ?? [])], recover: this.recover ?? null };
  }
  restore(snap) {
    const seconds = Math.max(0, (Date.now() - snap.wallMs) / 1000);
    this.ev = snap.ev; this.started = snap.started; this.startS = snap.startS; this.calibratedAt = snap.calibratedAt; this.offStart = snap.offStart;
    this.rebuild();
    if (snap.progress) { this.progress.idx = snap.progress.idx; this.progress.done = new Set(snap.progress.done); }
    const fill = this.engine.restore(snap.engine, { seconds, chord_m: null });
    if (snap.lastFix) this.pendingGap = { lat: snap.lastFix.lat, lon: snap.lastFix.lon, s: this.engine.s - fill, seconds, v: snap.engine.speed };
    if (snap.recover) this.recover = snap.recover;
    if (this.voice) for (const k of snap.said || []) this.voice.said.add(k);
    this.addLog(`Restored after ${seconds.toFixed(1)} s (estimated ${fill.toFixed(0)} m; corrected at the first GPS fix)`);
    return seconds;
  }
}

function fmtOm(x) { return x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(2); }
