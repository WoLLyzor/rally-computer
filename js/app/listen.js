// The tablet's microphone listening for Richta's beep (core/beepdetect.js), and learning the beep during
// Richta's Sound Check at check-in. Echo cancellation and noise suppression are off, so Android doesn't
// treat it as a phone call. Off unless the crew turns it on.
import { learnTones, BeepDetector } from '../core/beepdetect.js';

const FRAME_S = 0.03;

export class RichtaListener {
  constructor({ onBeep = () => {}, isSpeaking = () => false } = {}) {
    this.onBeep = onBeep; this.isSpeaking = isSpeaking; this.listening = false;
  }
  static supported() { return !!(navigator.mediaDevices?.getUserMedia && (window.AudioContext || window.webkitAudioContext)); }
  async open() {
    if (!this.an) {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.an = this.ctx.createAnalyser(); this.an.fftSize = 2048; this.an.smoothingTimeConstant = 0;
      src.connect(this.an);
      this.buf = new Float32Array(this.an.frequencyBinCount);
      this.binHz = this.ctx.sampleRate / this.an.fftSize;
    }
    await this.ctx.resume?.();
  }
  frame() { this.an.getFloatFrequencyData(this.buf); return Float32Array.from(this.buf); }
  // Record for `seconds` while Richta plays its Sound Check; returns the learned sound or null.
  async learn(seconds = 15, onProgress = () => {}) {
    await this.open();
    const frames = [], t0 = performance.now();
    await new Promise((done) => {
      const id = setInterval(() => {
        frames.push(this.frame());
        const f = (performance.now() - t0) / 1000 / seconds;
        onProgress(Math.min(1, f));
        if (f >= 1) { clearInterval(id); done(); }
      }, FRAME_S * 1000);
    });
    if (!this.listening) this.close();
    return learnTones(frames, { binHz: this.binHz, frameS: FRAME_S });
  }
  async start(sound) {
    await this.open();
    this.det = new BeepDetector(sound, { binHz: this.binHz, frameS: FRAME_S });
    this.listening = true;
    let quietUntil = 0;
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      const t = performance.now() / 1000;
      if (this.isSpeaking()) quietUntil = t + 0.7;   // never count our own voice
      if (this.det.push(this.frame(), t, t < quietUntil)) this.onBeep();
    }, FRAME_S * 1000);
  }
  // After a reload Chrome keeps audio paused until the first tap.
  resume() { this.ctx?.resume?.(); }
  stop() { this.listening = false; clearInterval(this.timer); this.close(); }
  close() {
    this.stream?.getTracks().forEach((tr) => tr.stop());
    this.ctx?.close?.();
    this.stream = null; this.ctx = null; this.an = null;
  }
}
