// Speed advisor (design §7): the speed that brings delta to the planned offset over about 20 s or
// 0.2 mile, capped at min(limit in effect, CAST + 10). Advice is never above the limit in effect (A5).

export function capFor({ castMph, limitMph, defaultLimit = 55, castMargin = 10 }) {
  const limit = Number.isFinite(limitMph) && limitMph > 0 ? limitMph : defaultLimit;
  const castCap = Number.isFinite(castMph) && castMph > 0 ? castMph + castMargin : limit;
  return Math.min(limit, castCap);
}

// delta: now − perfect (positive = late). offset: planned delta (negative while banking before a delay).
// Returns null when there is no CAST (transit zone, before the first CAST) or no delta.
export function targetSpeed({ deltaS, offsetS = 0, castMph, limitMph, defaultLimit = 55, horizonS = 20, horizonMi = 0.2 }) {
  if (!(castMph > 0) || deltaS === null || deltaS === undefined || !Number.isFinite(deltaS)) return null;
  const cap = capFor({ castMph, limitMph, defaultLimit });
  const h = Math.max(horizonMi, castMph * horizonS / 3600);
  const inv = 1 / castMph + (offsetS - deltaS) / (3600 * h);
  const raw = inv <= 0 ? Infinity : 1 / inv;
  return { raw, mph: Math.min(raw, cap), cap, capped: raw > cap };
}

// Smoothing and announcement policy: whole mph, spoken only on a change of at least 1 mph (and not
// more often than minGapS), immediately when the cap drops below what was last said.
export class SpeedAnnouncer {
  constructor({ tauS = 2.0, minGapS = 4 } = {}) {
    this.tauS = tauS; this.minGapS = minGapS;
    this.ema = null; this.shown = null; this.spoken = null; this.lastSpokenT = -Infinity;
  }
  // t: seconds; adv: result of targetSpeed (or null). Returns {display, speak}.
  update(t, adv) {
    if (!adv) { this.ema = null; this.shown = null; return { display: null, speak: null }; }
    const x = Math.min(adv.mph, adv.cap);
    if (this.ema === null || this.lastT === undefined) this.ema = x;
    else {
      const dt = Math.max(0, t - this.lastT);
      const a = 1 - Math.exp(-dt / this.tauS);
      this.ema += a * (x - this.ema);
    }
    this.lastT = t;
    const display = Math.max(0, Math.min(Math.round(this.ema), Math.floor(adv.cap + 1e-9)));
    this.shown = display;
    let speak = null;
    const capDrop = this.spoken !== null && this.spoken > Math.floor(adv.cap + 1e-9);
    if (this.spoken === null || capDrop || (Math.abs(display - this.spoken) >= 1 && t - this.lastSpokenT >= this.minGapS)) {
      if (this.spoken !== display) { speak = display; this.spoken = display; this.lastSpokenT = t; }
    }
    return { display, speak };
  }
}

// Limit in effect: the navigator's tap applies until the next executed instruction or a change in the
// map limit; otherwise the map limit; otherwise unknown (the advisor then uses the default cap).
export class LimitTracker {
  constructor() { this.nav = null; this.navAtN = null; this.mapLast = null; }
  setNav(mph, currentN) { this.nav = mph; this.navAtN = currentN; }
  current({ mapMph = null, currentN = null } = {}) {
    if (this.nav !== null && (this.navAtN !== currentN || (mapMph !== null && mapMph !== this.mapLast && this.mapLast !== null))) {
      this.nav = null;   // expired by a turn or a new map limit
    }
    this.mapLast = mapMph;
    if (this.nav !== null) return { mph: this.nav, src: 'nav' };
    if (mapMph !== null) return { mph: mapMph, src: 'map' };
    return { mph: null, src: null };
  }
}
