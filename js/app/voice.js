// Voice cues through the device's text-to-speech (works offline with the installed voice).
// Alerts interrupt; routine cues queue; a cue with a key is spoken at most once.

import { explain, speakable } from '../core/explain.js';

export { speakable };

// Instruction → short phrase for the driver, e.g. "right at the sign reading bear onto mill road".
export function instructionPhrase(ins, glossary = null) {
  return naturalPhrase(explain(ins, { glossary }).speech || speakable(ins.text || ''));
}
// Plain spoken English: "turn right onto mill road", "average speed 36".
export function naturalPhrase(p) {
  return String(p).replace(/^(left|right)\b/i, 'turn $1').replace(/\bcast (\d+)/gi, 'average speed $1');
}
// Spoken distance: yards up close, then tenths of a mile.
export function spokenDistance(mi) {
  if (mi < 0.5) return `${Math.max(50, Math.round(mi * 1760 / 50) * 50)} yards`;
  const t = Math.round(mi * 10) / 10;
  return t === 1 ? 'one mile' : `${t} miles`;
}

// The clearest English voice the tablet has offline: a natural/enhanced US voice if installed, else the default.
const PREFER = [/natural|neural/i, /enhanced|premium|high quality/i, /google us english/i, /samantha|aria|jenny|ava|allison/i];
export function pickVoice(voices, name = '') {
  const en = (voices || []).filter((v) => /^en[-_]US/i.test(v.lang) && v.localService !== false);
  if (name) { const v = en.find((x) => x.name === name); if (v) return v; }
  for (const re of PREFER) { const v = en.find((x) => re.test(x.name)); if (v) return v; }
  return en.find((v) => v.default) ?? en[0] ?? null;
}

export class Voice {
  constructor({ enabled = true, rate = 1.0, name = '' } = {}) {
    this.enabled = enabled; this.rate = rate; this.said = new Set(); this.ok = typeof speechSynthesis !== 'undefined';
    this.lastText = ''; this.log = []; this.name = name; this.voice = null;
    if (this.ok) {
      const pick = () => { this.voice = pickVoice(speechSynthesis.getVoices(), this.name); };
      pick();
      speechSynthesis.addEventListener?.('voiceschanged', pick);
    }
  }
  setName(name) { this.name = name; if (this.ok) this.voice = pickVoice(speechSynthesis.getVoices(), name); }
  speak(text, { key = null, alert = false } = {}) {
    if (key && this.said.has(key)) return false;
    if (key) this.said.add(key);
    this.lastText = text;
    this.lastSpokeAt = performance.now() / 1000;
    this.log.push({ t: Date.now(), text });
    this.onSay?.(text);
    if (!this.enabled || !this.ok) return false;
    if (alert) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = this.rate; u.lang = 'en-US';
    if (this.voice) u.voice = this.voice;
    speechSynthesis.speak(u);
    return true;
  }
  reset() { this.said.clear(); }
}
