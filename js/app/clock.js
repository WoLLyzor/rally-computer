// Rally clock (design §7 Clock; v1 §8.1). Rally time = GPS time from the RaceBox + the master-clock
// offset measured at check-in; without GPS time, the device clock + offset. Times are seconds of day, local.

const BLE_LATENCY_MS = 60;   // RaceBox fix epoch → notification arrival (estimate)

export class RallyClock {
  constructor(saved = null) {
    this.gpsMinusDevice = null;     // ms, smoothed
    this.masterMinusRef = saved?.masterMinusRef ?? 0;   // ms: master clock − reference (GPS or device)
    this.ref = saved?.ref ?? 'device';
    this.synced = !!saved?.synced;
  }
  // From a RaceBox sample with a valid, resolved UTC time.
  onGpsTime(utcMs, timeResolved) {
    if (!utcMs || !timeResolved) return;
    const d = utcMs + BLE_LATENCY_MS - Date.now();
    this.gpsMinusDevice = this.gpsMinusDevice === null ? d : this.gpsMinusDevice + 0.02 * (d - this.gpsMinusDevice);
  }
  refNowMs() { return Date.now() + (this.gpsMinusDevice ?? 0); }
  nowMs() { return this.refNowMs() + this.masterMinusRef; }
  // Seconds of day, local time zone (DST ends at 2:00 on 2026-11-01: the Date object handles it).
  todOf(ms) { const d = new Date(ms); return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000; }
  nowTod() { return this.todOf(this.nowMs()); }
  // Tap exactly as the master clock rolls over to a new minute: rally time snaps to that minute.
  syncToMinute() {
    const ref = this.refNowMs();
    const nearest = Math.round(ref / 60000) * 60000;
    this.ref = this.gpsMinusDevice === null ? 'device' : 'gps';
    this.masterMinusRef = nearest - ref;
    this.synced = true;
    return this.masterMinusRef;
  }
  save() { return { masterMinusRef: this.masterMinusRef, ref: this.ref, synced: this.synced }; }
}
