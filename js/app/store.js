// Small persistence layer over localStorage (settings, verified route, live state every second).
// Every access is guarded: storage can be unavailable or full, and the app must keep running.
const NS = 'rally.';

export const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(NS + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(NS + key, JSON.stringify(value)); return true; } catch (e) { console.warn('store.set', key, e); return false; }
  },
  del(key) { try { localStorage.removeItem(NS + key); } catch { /* ignore */ } },
};

export const DEFAULT_SETTINGS = {
  profile: 'offline', apiKey: '', modelA: 'claude-opus-5-5', modelB: 'claude-opus-5-5',
  carNumber: 1, baseStart: '11:00:00', timingUnit: 's', alpha: 0.5, defaultLimit: 55, taStep_s: 30, horizonMi: 0.15, horizonS: 15,
  voice: true, voiceRate: 1.0, sensorSource: 'auto', obdLagS: 0.3,
};

export function loadSettings() { return { ...DEFAULT_SETTINGS, ...(store.get('settings', {}) || {}) }; }
export function saveSettings(s) { store.set('settings', s); }
