// Tablet/phone GPS through the browser (backup speed source, and the fix for gap filling).
export class TabletGps {
  constructor({ onSample, onStatus = () => {} }) { this.onSample = onSample; this.onStatus = onStatus; this.id = null; }
  static supported() { return typeof navigator !== 'undefined' && 'geolocation' in navigator; }
  start() {
    if (this.id !== null || !TabletGps.supported()) return;
    this.id = navigator.geolocation.watchPosition((p) => {
      const c = p.coords;
      this.onSample({ src: 'gps', t: performance.now() / 1000, lat: c.latitude, lon: c.longitude, acc_m: c.accuracy,
        speed_mps: c.speed ?? null, heading_deg: c.heading ?? null, wallMs: p.timestamp });
      this.onStatus(c.accuracy < 20 ? 'ok' : 'degraded', `±${Math.round(c.accuracy)} m`);
    }, (e) => this.onStatus('lost', e.message), { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 });
  }
  stop() { if (this.id !== null) navigator.geolocation.clearWatch(this.id); this.id = null; }
}

// Bluetooth page-turner buttons pair with Android as a keyboard. MARK: arrows down/right, Page Down,
// Enter, Space, volume up (if delivered). NEXT/TALK (navigator): arrows up/left, Page Up.
const MARK_KEYS = new Set(['ArrowDown', 'ArrowRight', 'PageDown', 'Enter', ' ', 'AudioVolumeUp', 'MediaPlayPause', 'MediaTrackNext']);
const NEXT_KEYS = new Set(['ArrowUp', 'ArrowLeft', 'PageUp', 'MediaTrackPrevious']);
export function listenButtons(onButton, onAnyKey = () => {}) {
  const h = (e) => {
    onAnyKey(e.key);
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (MARK_KEYS.has(e.key)) { e.preventDefault(); onButton('mark'); }
    else if (NEXT_KEYS.has(e.key)) { e.preventDefault(); onButton('next'); }
  };
  window.addEventListener('keydown', h);
  return () => window.removeEventListener('keydown', h);
}
