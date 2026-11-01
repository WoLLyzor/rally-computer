// Distance engine (design v0 §7, v1 §8.2–8.3).
// A Kalman filter on [v speed m/s, b accelerometer bias m/s², c OBD scale] fuses RaceBox GPS Doppler
// speed (25 Hz), OBD wheel speed and tablet GPS speed; raw distance s integrates v (nothing below
// 0.5 mph). Official route miles D = a + K·s/MI, where K comes from the odometer check leg and
// (a, K) are refined by re-sync observations at exact-mileage turns and MARK presses.

export const MI = 1609.344;
const MPH = 0.44704;
const G = 9.80665;
const MIN_SPEED = 0.5 * MPH;

const add = (A, B) => A.map((r, i) => r.map((x, j) => x + B[i][j]));

export class DistanceEngine {
  constructor({ useImu = false, obdLagS = 0.3 } = {}) {
    this.useImu = useImu; this.obdLagS = obdLagS;
    this.x = [0, 0, 1];
    this.P = [[25, 0, 0], [0, 0.04, 0], [0, 0, 0.0025]];
    this.t = null;
    this.s = 0;                    // raw metres
    this.theta = [0, 1];           // [a (official mi), K (official ÷ raw)]
    this.Ptheta = [[1e-4, 0], [0, 1e-4]];
    this.calibrated = false;
    this.health = { racebox: 'off', obd: 'off', gps: 'off' };
    this.last = { racebox: -Infinity, rbGood: -Infinity, obd: -Infinity, gps: -Infinity };
    this.aMeas = 0;                // forward acceleration (m/s²) when the IMU is in use
    this.obdZeroSince = null; this.slowSince = null;
    this.hist = [];                // [{t, s}] for the last 120 s
    this.gap = null;               // GNSS outage bookkeeping (no OBD)
    this.lastFix = null;
    this.log = [];
    this.rejects = 0;
  }

  get K() { return this.theta[1]; }
  get D() { return this.theta[0] + this.theta[1] * this.s / MI; }
  get v() { return this.x[0]; }
  Dof(s) { return this.theta[0] + this.theta[1] * s / MI; }

  // Raw distance at an earlier time (turn midpoints, MARK minus reaction time).
  sAt(t) {
    const h = this.hist;
    if (!h.length || t >= h[h.length - 1].t) return this.s;
    for (let i = h.length - 1; i > 0; i--) {
      if (h[i - 1].t <= t) {
        const f = (t - h[i - 1].t) / (h[i].t - h[i - 1].t || 1);
        return h[i - 1].s + f * (h[i].s - h[i - 1].s);
      }
    }
    return h[0].s;
  }

  predict(t) {
    if (this.t === null) { this.t = t; return; }
    let dt = t - this.t;
    if (dt <= 0) return;
    if (dt > 5) dt = 5;   // a long stall: don't extrapolate further than this
    const [v, b] = this.x;
    const a = this.useImu ? this.aMeas - b : 0;
    const v1 = Math.max(0, v + a * dt);
    const vMid = (v + v1) / 2;
    if (vMid >= MIN_SPEED) this.s += vMid * dt;
    this.x[0] = v1;
    const sa = this.useImu ? 0.4 : 1.5;   // unmodelled acceleration (m/s²)
    const F = [[1, this.useImu ? -dt : 0, 0], [0, 1, 0], [0, 0, 1]];
    const FP = F.map((r) => [0, 1, 2].map((j) => r[0] * this.P[0][j] + r[1] * this.P[1][j] + r[2] * this.P[2][j]));
    const FPFt = FP.map((r) => [0, 1, 2].map((j) => r[0] * F[j][0] + r[1] * F[j][1] + r[2] * F[j][2]));
    this.P = add(FPFt, [[sa * sa * dt, 0, 0], [0, 1e-6 * dt, 0], [0, 0, 1e-8 * dt]]);
    this.t = t;
    this.hist.push({ t, s: this.s });
    while (this.hist.length && this.hist[0].t < t - 120) this.hist.shift();
  }

  // Scalar measurement z = H·x with variance R. Returns false when gated out.
  update(z, H, R, gate = 5) {
    const PHt = [0, 1, 2].map((i) => H[0] * this.P[i][0] + H[1] * this.P[i][1] + H[2] * this.P[i][2]);
    const S = H[0] * PHt[0] + H[1] * PHt[1] + H[2] * PHt[2] + R;
    const zhat = H[0] * this.x[0] + H[1] * this.x[1] + H[2] * this.x[2];
    const inn = z - zhat;
    if (inn * inn > gate * gate * S && Math.abs(inn) > 1.0) { this.rejects++; return false; }
    const Kg = PHt.map((p) => p / S);
    this.x = this.x.map((x, i) => x + Kg[i] * inn);
    this.x[0] = Math.max(0, this.x[0]);
    this.P = this.P.map((r, i) => r.map((p, j) => p - Kg[i] * PHt[j]));
    this.rejects = 0;
    return true;
  }

  // Unified sample input. RaceBox samples: decodeRaceBox() fields + t (s). OBD: {src:'obd', t, kmh}.
  // Tablet GPS: {src:'gps', t, lat, lon, acc_m, speed_mps|null}.
  ingest(sm) {
    const t = sm.t;
    this.predict(t);
    if (sm.src === 'racebox') this.onRaceBox(sm, t);
    else if (sm.src === 'obd') this.onObd(sm, t);
    else if (sm.src === 'gps') this.onGps(sm, t);
    this.updateHealth(t);
    return this.D;
  }

  onRaceBox(sm, t) {
    this.last.racebox = t;
    if (this.useImu && sm.aFwd_mps2 !== undefined) this.aMeas = sm.aFwd_mps2;
    const good = sm.fixOk && !sm.coordsInvalid && sm.sAcc_mps < 2.0;
    if (!good) return;
    let sigma = Math.max(0.05, sm.sAcc_mps);
    if (sm.numSV < 6) sigma *= 3;
    if (sm.hAcc_m > 15) sigma *= 2;
    const obdLive = t - this.last.obd < 1.0;
    this.closeGap(sm, t, obdLive);
    if (this.update(sm.speed_mps, [1, 0, 0], sigma * sigma) || this.rejects > 25) {
      if (this.rejects > 25) { this.x[0] = sm.speed_mps; this.rejects = 0; this.note(t, 'speed re-initialised from GPS'); }
    }
    this.last.rbGood = t;
    this.lastFix = { t, lat: sm.lat, lon: sm.lon, s: this.s };
    this.stoppedCheck(t, sm.speed_mps, sm.imuQuiet);
  }

  onObd(sm, t) {
    const prev = this.last.obd;
    this.last.obd = t;
    // OBD speed lags the wheels; project it forward by the lag using the IMU, else the OBD trend.
    const raw = sm.kmh / 3.6;
    if (this.obdPrev && t > this.obdPrev.t) {
      const rate = (raw - this.obdPrev.v) / (t - this.obdPrev.t);
      const a = 1 - Math.exp(-(t - this.obdPrev.t) / 0.4);
      this.obdRate = (this.obdRate ?? 0) + a * (rate - (this.obdRate ?? 0));
    }
    this.obdPrev = { t, v: raw };
    const lead = this.useImu ? (this.aMeas - this.x[1]) : (this.obdRate ?? 0);
    const z = raw + lead * this.obdLagS;
    const [v, , c] = this.x;
    this.update(z, [c, 0, v], 0.1 * 0.1 + 0.0064);
    if (sm.kmh === 0) { if (this.obdZeroSince === null || t - prev > 2) this.obdZeroSince = t; }
    else this.obdZeroSince = null;
    if (this.obdZeroSince !== null && t - this.obdZeroSince >= 1.0) this.update(0, [1, 0, 0], 0.02 * 0.02, 1e9);
  }

  onGps(sm, t) {
    this.last.gps = t;
    const rbOk = t - this.last.rbGood < 1.0;
    if (rbOk || sm.speed_mps === null || sm.speed_mps === undefined || !(sm.acc_m < 30)) return;
    this.closeGap({ lat: sm.lat, lon: sm.lon }, t, t - this.last.obd < 1.0);
    this.update(sm.speed_mps, [1, 0, 0], 0.6 * 0.6);
    this.lastFix = { t, lat: sm.lat, lon: sm.lon, s: this.s };
    this.stoppedCheck(t, sm.speed_mps);
  }

  // Stop detection without OBD: GPS speed near zero, confirmed by a quiet gyro and accelerometer when the
  // RaceBox supplies them (imuQuiet true/false), else GPS alone for longer.
  stoppedCheck(t, gnssSpeed, imuQuiet) {
    if (t - this.last.obd < 1.0) return;   // OBD decides stops when present
    const slow = imuQuiet === undefined ? gnssSpeed < 0.3 : gnssSpeed < 0.5 && imuQuiet;
    if (slow) { if (this.slowSince === null) this.slowSince = t; }
    else this.slowSince = null;
    const hold = imuQuiet === undefined ? 1.5 : 0.6;
    if (this.slowSince !== null && t - this.slowSince >= hold) this.update(0, [1, 0, 0], 0.03 * 0.03, 1e9);
  }

  // After a GNSS outage of more than 2 s with no OBD, the dead-reckoned distance is kept within
  // [chord, 1.05 × chord] of the straight line between the fixes on either side of the gap.
  closeGap(fix, t, obdLive) {
    const lf = this.lastFix;
    if (!lf || obdLive || t - lf.t <= 2.0 || !(fix.lat && fix.lon)) return;
    const chord = haversine(lf.lat, lf.lon, fix.lat, fix.lon);
    const dr = this.s - lf.s;
    const fixed = Math.min(Math.max(dr, chord), chord * 1.05);
    if (Math.abs(fixed - dr) > 1) {
      this.s = lf.s + fixed;
      this.note(t, `GPS gap ${(t - lf.t).toFixed(1)} s: distance ${dr.toFixed(0)} m → ${fixed.toFixed(0)} m`);
    }
  }

  updateHealth(t) {
    const st = (age, okAge, lostAge) => (age < okAge ? 'ok' : age < lostAge ? 'degraded' : 'lost');
    if (this.last.racebox > -Infinity) {
      this.health.racebox = t - this.last.racebox > 2 ? 'lost' : t - this.last.rbGood < 0.5 ? 'ok' : 'degraded';
    }
    if (this.last.obd > -Infinity) this.health.obd = st(t - this.last.obd, 1.0, 3.0);
    if (this.last.gps > -Infinity) this.health.gps = st(t - this.last.gps, 2.0, 5.0);
  }

  note(t, text) { this.log.push({ t, text }); if (this.log.length > 500) this.log.shift(); }

  // ---- Official miles ----

  // Start of the rally (or of the odometer check): D = D0 here, or at the earlier raw distance s.
  zero(D0 = 0, s = this.s) { this.theta = [D0 - this.theta[1] * s / MI, this.theta[1]]; }

  // End of the odometer check leg: official distance from the start point, measured raw distance.
  calibrate({ omStart = 0, sStart = 0, omEnd, sEnd = this.s }) {
    const raw = (sEnd - sStart) / MI;
    if (!(raw > 0.5)) return null;
    const K = (omEnd - omStart) / raw;
    this.theta = [omEnd - K * sEnd / MI, K];
    this.Ptheta = [[(0.004) ** 2, 0], [0, (0.002) ** 2]];
    this.calibrated = true;
    this.note(this.t ?? 0, `calibrated K=${K.toFixed(5)} over ${(omEnd - omStart).toFixed(2)} mi`);
    return K;
  }

  // Re-sync observation: the car was at official route mileage D_obs when raw distance was s_obs.
  // Gate 0.03 mi (design); otherwise a 2-state Kalman update of (a, K) with forgetting per mile.
  resync({ D_obs, s_obs, sigmaMi = 0.006, force = false, label = '' }) {
    const m = s_obs / MI;
    const pred = this.theta[0] + this.theta[1] * m;
    const inn = D_obs - pred;
    if (Math.abs(inn) > 0.03 && !force) {
      this.note(this.t ?? 0, `re-sync ${label} rejected: ${inn >= 0 ? '+' : ''}${inn.toFixed(3)} mi`);
      return { accepted: false, residual: inn };
    }
    const miles = Math.max(0, m - (this.lastResyncM ?? m));
    this.lastResyncM = m;
    const Q = [[(0.002) ** 2 * miles, 0], [0, (5e-5) ** 2 * miles]];
    const P = add(this.Ptheta, Q);
    const H = [1, m];
    const PHt = [P[0][0] * H[0] + P[0][1] * H[1], P[1][0] * H[0] + P[1][1] * H[1]];
    const S = H[0] * PHt[0] + H[1] * PHt[1] + sigmaMi * sigmaMi;
    const Kg = [PHt[0] / S, PHt[1] / S];
    const before = this.D;
    this.theta = [this.theta[0] + Kg[0] * inn, this.theta[1] + Kg[1] * inn];
    this.Ptheta = [[P[0][0] - Kg[0] * PHt[0], P[0][1] - Kg[0] * PHt[1]], [P[1][0] - Kg[1] * PHt[0], P[1][1] - Kg[1] * PHt[1]]];
    const jump = this.D - before;
    this.note(this.t ?? 0, `re-sync ${label}: residual ${inn >= 0 ? '+' : ''}${inn.toFixed(3)} mi, D moved ${jump >= 0 ? '+' : ''}${jump.toFixed(3)}, K=${this.theta[1].toFixed(5)}`);
    return { accepted: true, residual: inn, jump };
  }

  // Re-anchor after a pause: the car was at official mileage D_obs at raw distance s_obs. Unlike a
  // re-sync this takes the whole correction at once (no gate) and keeps the calibration factor.
  reanchor(D_obs, s_obs, label = '') {
    const before = this.D;
    this.theta = [D_obs - this.theta[1] * s_obs / MI, this.theta[1]];
    this.Ptheta = [[Math.max(this.Ptheta[0][0], 0.006 ** 2), this.Ptheta[0][1]], [this.Ptheta[1][0], this.Ptheta[1][1]]];
    this.lastResyncM = s_obs / MI;
    const jump = this.D - before;
    this.note(this.t ?? 0, `re-anchor ${label}: D moved ${jump >= 0 ? '+' : ''}${jump.toFixed(3)}`);
    return jump;
  }

  // ---- Crash-safe state (saved every second; design §7) ----
  snapshot(wallMs) {
    return { v: 1, wallMs, s: this.s, x: this.x, P: this.P, theta: this.theta, Ptheta: this.Ptheta, calibrated: this.calibrated,
      lastFix: this.lastFix ? { lat: this.lastFix.lat, lon: this.lastFix.lon } : null, speed: this.x[0] };
  }
  // Restore after a restart. gap = {seconds, chord_m|null}: the distance driven while the app was down is
  // the chord between the saved fix and the first new fix (bounded like a GNSS gap), else speed × time.
  restore(snap, { seconds = 0, chord_m = null } = {}) {
    Object.assign(this, { s: snap.s, x: snap.x, P: snap.P, theta: snap.theta, Ptheta: snap.Ptheta, calibrated: snap.calibrated });
    const dr = snap.speed * seconds;
    const fill = chord_m === null ? dr : Math.min(Math.max(dr, chord_m), chord_m * 1.05);
    this.s += fill;
    this.t = null; this.hist = []; this.lastFix = null;
    this.note(0, `restored after ${seconds.toFixed(1)} s; filled ${fill.toFixed(0)} m`);
    return fill;
  }
}

export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371008.8, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Forward acceleration from the RaceBox accelerometer, mount-independent: gravity direction from a slow
// average, forward direction learned while GPS speed changes in a straight line. Returns m/s² or null.
export class ImuFrame {
  constructor() { this.up = null; this.fwd = null; this.n = 0; }
  push(acc_g, { gnssAccel = null, yawRate = 0 } = {}) {
    const a = acc_g;
    if (!this.up) this.up = [...a];
    else for (let k = 0; k < 3; k++) this.up[k] += 0.002 * (a[k] - this.up[k]);
    const gl = Math.hypot(...this.up) || 1;
    const u = this.up.map((x) => x / gl);
    const dot = a[0] * u[0] + a[1] * u[1] + a[2] * u[2];
    const h = [a[0] - dot * u[0], a[1] - dot * u[1], a[2] - dot * u[2]];   // horizontal specific force (g)
    if (gnssAccel !== null && Math.abs(gnssAccel) > 0.8 && Math.abs(yawRate) < 3) {
      const sgn = Math.sign(gnssAccel);
      if (!this.fwd) this.fwd = h.map((x) => x * sgn);
      else for (let k = 0; k < 3; k++) this.fwd[k] += 0.02 * (h[k] * sgn - this.fwd[k]);
      this.n++;
    }
    if (!this.fwd || this.n < 50) return null;
    const fl = Math.hypot(...this.fwd) || 1;
    return ((h[0] * this.fwd[0] + h[1] * this.fwd[1] + h[2] * this.fwd[2]) / fl) * G;
  }
  // Yaw rate (deg/s, positive = left/counter-clockwise from above) from the gyro and the gravity direction.
  yawRate(gyro_dps) {
    if (!this.up) return null;
    const gl = Math.hypot(...this.up) || 1;
    return (gyro_dps[0] * this.up[0] + gyro_dps[1] * this.up[1] + gyro_dps[2] * this.up[2]) / gl;
  }
}

// Quiet-vehicle detector for stops: low gyro rate and little accelerometer vibration over ~0.5 s.
export class ImuQuiet {
  constructor({ gyroDps = 2.0, accG = 0.04 } = {}) { this.gyroDps = gyroDps; this.accG = accG; this.slow = null; this.g = 0; this.dev = 0; }
  push(acc_g, gyro_dps) {
    if (!acc_g || !gyro_dps) return undefined;
    if (!this.slow) this.slow = [...acc_g];
    for (let k = 0; k < 3; k++) this.slow[k] += 0.02 * (acc_g[k] - this.slow[k]);   // ~2 s at 25 Hz
    const d = Math.hypot(acc_g[0] - this.slow[0], acc_g[1] - this.slow[1], acc_g[2] - this.slow[2]);
    this.dev += 0.08 * (d - this.dev);                                                // ~0.5 s
    this.g += 0.08 * (Math.hypot(...gyro_dps) - this.g);
    return this.g < this.gyroDps && this.dev < this.accG;
  }
}
