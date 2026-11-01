// UBX-framed stream parser and the RaceBox Data Message decoder (RaceBox BLE protocol rev 9).
// Frame: B5 62 | class | id | len (U16 LE) | payload | CK_A CK_B (8-bit Fletcher over class..payload).
// BLE notifications may split or join frames, so bytes are buffered and resynced on B5 62.

export function ubxChecksum(bytes, start, end) {
  let a = 0, b = 0;
  for (let i = start; i < end; i++) { a = (a + bytes[i]) & 0xff; b = (b + a) & 0xff; }
  return [a, b];
}

export function ubxFrame(cls, id, payload = new Uint8Array(0)) {
  const out = new Uint8Array(8 + payload.length);
  out[0] = 0xb5; out[1] = 0x62; out[2] = cls; out[3] = id;
  out[4] = payload.length & 0xff; out[5] = payload.length >> 8;
  out.set(payload, 6);
  const [a, b] = ubxChecksum(out, 2, 6 + payload.length);
  out[6 + payload.length] = a; out[7 + payload.length] = b;
  return out;
}

export class UbxParser {
  constructor(onMessage) { this.onMessage = onMessage; this.buf = new Uint8Array(0); this.badChecksums = 0; this.frames = 0; }
  feed(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf); merged.set(chunk, this.buf.length);
    let i = 0;
    while (i + 8 <= merged.length) {
      if (merged[i] !== 0xb5 || merged[i + 1] !== 0x62) { i++; continue; }
      const len = merged[i + 4] | (merged[i + 5] << 8);
      if (len > 504) { i++; continue; }                       // impossible length: false sync
      if (i + 8 + len > merged.length) break;                  // wait for the rest
      const [a, b] = ubxChecksum(merged, i + 2, i + 6 + len);
      if (merged[i + 6 + len] !== a || merged[i + 7 + len] !== b) { this.badChecksums++; i++; continue; }
      const payload = merged.slice(i + 6, i + 6 + len);
      this.frames++;
      this.onMessage(merged[i + 2], merged[i + 3], payload);
      i += 8 + len;
    }
    this.buf = merged.slice(i);
    if (this.buf.length > 4096) this.buf = this.buf.slice(-1024);
  }
}

// RaceBox Data Message: class 0xFF, id 0x01, 80-byte payload. Units converted to SI / degrees.
export function decodeRaceBox(p) {
  if (p.length !== 80) return null;
  const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const fixFlags = v.getUint8(21);
  const valid = v.getUint8(11);
  const year = v.getUint16(4, true), month = v.getUint8(6), day = v.getUint8(7);
  const hour = v.getUint8(8), minute = v.getUint8(9), second = v.getUint8(10);
  const nano = v.getInt32(16, true);
  const timeValid = (valid & 0x03) === 0x03;
  const battery = v.getUint8(67);
  return {
    src: 'racebox',
    iTOW: v.getUint32(0, true),
    utc_ms: timeValid ? Date.UTC(year, month - 1, day, hour, minute, second) + nano / 1e6 : null,
    timeResolved: (valid & 0x04) !== 0,
    tAcc_ns: v.getUint32(12, true),
    fix: v.getUint8(20),
    fixOk: v.getUint8(20) === 3 && (fixFlags & 0x01) !== 0,
    headingValid: (fixFlags & 0x20) !== 0,
    numSV: v.getUint8(23),
    lon: v.getInt32(24, true) * 1e-7,
    lat: v.getInt32(28, true) * 1e-7,
    altMsl_m: v.getInt32(36, true) / 1000,
    hAcc_m: v.getUint32(40, true) / 1000,
    vAcc_m: v.getUint32(44, true) / 1000,
    speed_mps: v.getInt32(48, true) / 1000,
    heading_deg: v.getInt32(52, true) * 1e-5,
    sAcc_mps: v.getUint32(56, true) / 1000,
    headAcc_deg: v.getUint32(60, true) * 1e-5,
    pdop: v.getUint16(64, true) / 100,
    coordsInvalid: (v.getUint8(66) & 0x01) !== 0,
    battery_pct: battery & 0x7f, charging: (battery & 0x80) !== 0,
    acc_g: [v.getInt16(68, true) / 1000, v.getInt16(70, true) / 1000, v.getInt16(72, true) / 1000],
    gyro_dps: [v.getInt16(74, true) / 100, v.getInt16(76, true) / 100, v.getInt16(78, true) / 100],
  };
}

// Test helper: build a Data Message payload from fields (inverse of decodeRaceBox).
export function encodeRaceBox(f) {
  const p = new Uint8Array(80);
  const v = new DataView(p.buffer);
  const d = new Date(Math.floor(f.utc_ms ?? 0));
  v.setUint32(0, f.iTOW ?? 0, true);
  v.setUint16(4, d.getUTCFullYear(), true); v.setUint8(6, d.getUTCMonth() + 1); v.setUint8(7, d.getUTCDate());
  v.setUint8(8, d.getUTCHours()); v.setUint8(9, d.getUTCMinutes()); v.setUint8(10, d.getUTCSeconds());
  v.setUint8(11, 0x07);
  v.setUint32(12, f.tAcc_ns ?? 30, true);
  v.setInt32(16, Math.round(((f.utc_ms ?? 0) % 1000) * 1e6), true);
  v.setUint8(20, f.fix ?? 3); v.setUint8(21, (f.fixOk === false ? 0 : 1) | (f.headingValid === false ? 0 : 0x20));
  v.setUint8(23, f.numSV ?? 12);
  v.setInt32(24, Math.round((f.lon ?? 0) * 1e7), true); v.setInt32(28, Math.round((f.lat ?? 0) * 1e7), true);
  v.setInt32(36, Math.round((f.altMsl_m ?? 0) * 1000), true);
  v.setUint32(40, Math.round((f.hAcc_m ?? 1) * 1000), true); v.setUint32(44, Math.round((f.vAcc_m ?? 2) * 1000), true);
  v.setInt32(48, Math.round((f.speed_mps ?? 0) * 1000), true);
  v.setInt32(52, Math.round((f.heading_deg ?? 0) * 1e5), true);
  v.setUint32(56, Math.round((f.sAcc_mps ?? 0.1) * 1000), true);
  v.setUint32(60, Math.round((f.headAcc_deg ?? 1) * 1e5), true);
  v.setUint16(64, Math.round((f.pdop ?? 1.2) * 100), true);
  v.setUint8(67, f.battery_pct ?? 80);
  const acc = f.acc_g ?? [0, 0, 1], gyro = f.gyro_dps ?? [0, 0, 0];
  for (let k = 0; k < 3; k++) { v.setInt16(68 + 2 * k, Math.round(acc[k] * 1000), true); v.setInt16(74 + 2 * k, Math.round(gyro[k] * 100), true); }
  return p;
}
