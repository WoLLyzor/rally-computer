// RaceBox Mini over Web Bluetooth (Chrome on Android/desktop; not iOS Safari).
// Nordic UART service; data streams at up to 25 Hz as soon as notifications start.
// One BLE central at a time: close the RaceBox phone app first.

import { UbxParser, decodeRaceBox } from './ubx.js';

export const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';   // write
export const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';   // notify

export class RaceBox {
  constructor({ onSample, onStatus = () => {} }) {
    this.onSample = onSample; this.onStatus = onStatus;
    this.device = null; this.char = null; this.wanted = false; this.retryTimer = null;
    this.parser = new UbxParser((cls, id, payload) => {
      if (cls === 0xff && id === 0x01) {
        const s = decodeRaceBox(payload);
        if (s) { s.t_rx = performance.now() / 1000; this.onSample(s); }
      }
    });
    this.onNotify = (e) => {
      const dv = e.target.value;
      this.parser.feed(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
    };
    this.onDisconnect = () => { this.onStatus('lost', 'disconnected'); if (this.wanted) this.scheduleReconnect(); };
  }

  static supported() { return typeof navigator !== 'undefined' && !!navigator.bluetooth; }

  // Must run from a user gesture the first time (Chrome shows its device chooser).
  async pick() {
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'RaceBox' }],
      optionalServices: [NUS_SERVICE, 'device_information'],
    });
    this.device.addEventListener('gattserverdisconnected', this.onDisconnect);
    return this.connect();
  }

  // After an app restart: reuse a device the user already allowed, when the browser supports it.
  async restore() {
    if (!navigator.bluetooth?.getDevices) return false;
    const devices = await navigator.bluetooth.getDevices();
    const d = devices.find((x) => (x.name || '').startsWith('RaceBox'));
    if (!d) return false;
    this.device = d;
    this.device.addEventListener('gattserverdisconnected', this.onDisconnect);
    try { await this.connect(); return true; } catch { this.scheduleReconnect(); return false; }
  }

  async connect() {
    this.wanted = true;
    this.onStatus('degraded', 'connecting');
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(NUS_SERVICE);
    this.char = await svc.getCharacteristic(NUS_TX);
    this.char.addEventListener('characteristicvaluechanged', this.onNotify);
    await this.char.startNotifications();
    this.onStatus('ok', this.device.name);
    return this.device.name;
  }

  scheduleReconnect() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(async () => {
      if (!this.wanted || this.device?.gatt?.connected) return;
      try { await this.connect(); } catch (e) { this.onStatus('lost', 'retrying'); this.scheduleReconnect(); }
    }, 2000);
  }

  disconnect() {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    try { this.device?.gatt?.disconnect(); } catch { /* already gone */ }
  }
}
