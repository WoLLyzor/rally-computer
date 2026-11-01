// Voice cues through the device's text-to-speech (works offline with the installed voice).
// Alerts interrupt; routine cues queue; a cue with a key is spoken at most once.

import { explain, speakable } from '../core/explain.js';

export { speakable };

// Instruction → short phrase for the driver, e.g. "right at the sign reading bear onto mill road".
export function instructionPhrase(ins, glossary = null) {
  return explain(ins, { glossary }).speech || speakable(ins.text || '');
}

export class Voice {
  constructor({ enabled = true, rate = 1.0 } = {}) {
    this.enabled = enabled; this.rate = rate; this.said = new Set(); this.ok = typeof speechSynthesis !== 'undefined';
    this.lastText = ''; this.log = [];
  }
  speak(text, { key = null, alert = false } = {}) {
    if (key && this.said.has(key)) return false;
    if (key) this.said.add(key);
    this.lastText = text;
    this.lastSpokeAt = performance.now() / 1000;
    this.log.push({ t: Date.now(), text });
    if (!this.enabled || !this.ok) return false;
    if (alert) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = this.rate; u.lang = 'en-US';
    speechSynthesis.speak(u);
    return true;
  }
  reset() { this.said.clear(); }
}
