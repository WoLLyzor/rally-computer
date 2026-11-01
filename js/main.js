// App shell and integration: screens, route state, sensors, live loop, persistence, offline cache.
import { h, clear } from './ui/dom.js';
import { mountScan } from './ui/scan.js';
import { mountVerify } from './ui/verify.js';
import { mountSettings } from './ui/settings.js';
import { mountDriver } from './ui/driver.js';
import { mountNavigator } from './ui/navigator.js';
import { mountMap } from './ui/map.js';
import { parseText, reparse } from './core/parser.js';
import { runChecks, computeLegs, assignSections, normalizeInstruction, fmtTod } from './core/instruction.js';
import { extractPages, buildDigest } from './core/extract.js';
import { store, loadSettings, saveSettings } from './app/store.js';
import { RallyClock } from './app/clock.js';
import { Voice } from './app/voice.js';
import { LiveLoop } from './app/live.js';
import { segmentTable } from './core/timing.js';
import { renderTimes } from './ui/times.js';
import { prepareImage } from './app/image.js';
import { RaceBox } from './sensors/racebox.js';
import { TabletGps, listenButtons } from './sensors/gps.js';

const app = document.getElementById('app');
const S = {
  settings: loadSettings(),
  route: store.get('route', null),          // { instructions, pageRowCounts, extraFlags, source, savedAt }
  pages: [],                                 // photos for the verify screen (memory only)
  status: { racebox: 'off', obd: 'off', gps: 'off', lastKey: '' },
  view: null, timer: null,
};
const clock = new RallyClock(store.get('clock', null));
const voice = new Voice({ enabled: S.settings.voice, rate: S.settings.voiceRate });
let live = null;
let racebox = null, gps = null;
let wakeLock = null;

// ---------- route helpers ----------
function checksFor(ins) {
  const flags = runChecks(ins, { pageRowCounts: S.route?.pageRowCounts ?? null });
  return [...(S.route?.extraFlags || []), ...flags];
}
function setRoute(instructions, extra = {}) {
  const ins = instructions.map(normalizeInstruction);
  if (!ins.some((r) => r.section > 1)) assignSections(ins);
  S.route = { ...(S.route || {}), ...extra, instructions: ins, savedAt: Date.now() };
  store.set('route', S.route);
  if (live) {
    live.setRoute(ins, { keepPlace: !extra.source });   // a fix to one line mid-rally keeps the place
    if (live.started) saveLive();
  }
}
const verifiedCount = () => (S.route?.instructions || []).filter((r) => r.verified).length;

// ---------- live loop ----------
function ensureLive() {
  if (live) return live;
  live = new LiveLoop({ settings: S.settings, clock, voice });
  live.setRoute(S.route?.instructions || []);
  const snap = store.get('live', null);
  if (snap && snap.routeSavedAt === S.route?.savedAt && Date.now() - snap.wallMs < 6 * 3600e3) live.restore(snap);
  return live;
}
function startSensors() {
  ensureLive();
  if (!gps && TabletGps.supported()) {
    gps = new TabletGps({ onSample: (sm) => live.ingest(sm), onStatus: (s) => { S.status.gps = s; } });
    gps.start();
  }
  if (!racebox && RaceBox.supported()) {
    racebox = new RaceBox({ onSample: (sm) => live.ingest(sm), onStatus: (s, m) => { S.status.racebox = `${s} ${m || ''}`; } });
    racebox.restore().catch(() => {});
  }
}
async function connectRaceBox() {
  startSensors();
  if (!racebox) { alert('This browser has no Bluetooth (use Chrome on Android).'); return; }
  try { await racebox.pick(); } catch (e) { S.status.racebox = `lost ${e.message}`; }
}
async function keepAwake() {
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch { /* not allowed */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && (location.hash === '#drive' || live?.started)) keepAwake(); });
listenButtons((b) => { S.status.lastKey = b; if (live && (location.hash === '#drive' || live.started)) live.action(b === 'mark' ? 'mark' : 'ack'); }, (k) => { S.status.lastKey = k; });

// ---------- screens ----------
function teardown() {
  clearInterval(S.timer); S.timer = null; S.driving = false;
  if (S.view?.destroy) S.view.destroy();
  S.view = null;
  clear(app);
}

function topbar(title, extra = []) {
  return h('div', { class: 'topbar' }, h('button', { onclick: () => { location.hash = '#home'; } }, '‹ Home'), h('b', {}, title), h('span', { class: 'sp' }), ...extra);
}

function showHome() {
  const n = S.route?.instructions?.length || 0;
  const v = verifiedCount();
  const c = clock.synced ? `synced (${(clock.masterMinusRef / 1000).toFixed(2)} s vs ${clock.ref})` : 'not synced';
  const legs = n ? computeLegs(S.route.instructions).length : 0;
  app.append(h('div', { class: 'home' },
    h('h1', {}, 'Rally computer'),
    h('div', { class: 'muted' }, `Car ${S.settings.carNumber} · start ${fmtTod(clockStart())} · ${S.settings.profile === 'cloud' ? 'cloud reading' : 'offline'} · timing in ${S.settings.timingUnit === 'cent' ? 'cents' : 'seconds'}`),
    step('1 · Read the instructions', n ? `${n} instructions in ${legs} legs` : 'Photograph or type them', 'Read', '#scan'),
    step('2 · Driver verifies', n ? `${v} of ${n} verified` : '—', 'Verify', '#verify', !n),
    step('3 · Clock', `Tap exactly as the master clock rolls over a minute · ${c}`, 'Sync now', null, false, () => { clock.syncToMinute(); store.set('clock', clock.save()); route(); }),
    step('4 · Drive', live?.started ? 'Rally in progress' : 'Connect the RaceBox, then go', 'Drive', '#drive', !n, null, true),
    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
      h('button', { onclick: () => { location.hash = '#diag'; } }, 'Device check'),
      h('button', { onclick: () => { location.hash = '#settings'; } }, 'Settings'),
      h('button', { onclick: () => { location.hash = '#log'; } }, 'Log'),
      h('button', { onclick: () => { location.hash = '#paper'; } }, 'Time table'),
      h('button', { onclick: () => { if (confirm('Clear the live rally state (distance, marks, checkpoint times)? The route stays.')) { store.del('live'); location.reload(); } } }, 'Reset rally state')),
  ));
}
function step(title, sub, label, hash, disabled = false, fn = null, primary = false) {
  return h('div', { class: 'step' }, h('div', {}, h('b', {}, title), h('div', { class: 'muted' }, sub)),
    h('button', { class: primary ? 'primary' : '', disabled, onclick: () => { if (fn) fn(); else location.hash = hash; } }, label));
}
function clockStart() { const [hh, mm, ss] = S.settings.baseStart.split(':').map(Number); return hh * 3600 + mm * 60 + (ss || 0) + 60 * S.settings.carNumber; }

function showScan() {
  app.append(topbar('Read instructions'));
  const box = h('div', {}); app.append(box);
  S.view = mountScan(box, {
    profile: S.settings.profile,
    onPagesChanged: (pages) => { S.pages = pages; },
    onPasteText: (text) => {
      const list = parseText(text);
      const digest = list.standing.length ? { ...buildDigest([]), special_instructions: list.standing } : null;
      setRoute(list, { source: 'typed', pageRowCounts: null, extraFlags: [], digest, pageKinds: null });
      location.hash = '#verify';
    },
    onExtract: async (pages) => {
      S.pages = pages;
      if (S.settings.profile !== 'cloud') { alert('Offline photo reading is not in this version. Use "Type or paste instructions", or switch to cloud reading in Settings (only with the rallymaster\'s written OK).'); return; }
      if (!S.settings.apiKey) { alert('Add your Claude API key in Settings first.'); return; }
      try {
        const { default: Anthropic } = await import('../vendor/anthropic-sdk.mjs');
        const client = new Anthropic({ apiKey: S.settings.apiKey, dangerouslyAllowBrowser: true, maxRetries: 6 });
        // Each finished pass is saved as it arrives, keyed by the photo, so a reload or a second tap
        // only reads what is still missing.
        const fp = (p) => `${p.file?.name}|${p.file?.size}|${p.file?.lastModified}`;
        const saved = store.get('scan', {}) || {};
        const keep = {}, cached = {};
        for (const p of pages) { keep[fp(p)] = saved[fp(p)] || {}; cached[p.page] = keep[fp(p)]; }
        const complete = (c) => c.A?.data && (c.A.data.page_kind === 'other' || (c.A.data.page_kind === 'general' ? c.G?.data : c.B?.data));
        const prepared = [];
        for (const p of pages) prepared.push({ page: p.page, image: complete(cached[p.page]) ? null : () => prepareImage(p.file) });
        keepAwake();   // a sleeping screen can pause the reading
        const res = await extractPages(client, prepared, { modelA: S.settings.modelA, modelB: S.settings.modelB, cached,
          onProgress: (e) => S.view?.progress?.(e),
          onResult: (page, pass, r) => {
            const k = fp(pages.find((p) => p.page === page));
            (keep[k] ||= {})[pass] = { data: r.data, usage: r.usage };
            store.set('scan', keep);
          } });
        S.view?.finished?.({ failedPages: res.failedPages, pageKinds: res.pageKinds });
        if (!res.instructions.length) { alert(res.digest.pages.length ? 'Only general-instruction pages were read: no route instructions yet.' : 'No instructions could be read. Check the photos and try again.'); if (!res.digest.pages.length) return; }
        setRoute(res.instructions, { source: 'cloud', pageRowCounts: res.pageRowCounts, extraFlags: res.pageFlags, usage: res.usage, digest: res.digest, pageKinds: res.pageKinds });
        if (res.digest.timing_unit === 'hundredths' && S.settings.timingUnit !== 'cent'
          && confirm('The general instructions score in hundredths of a minute. Show times in hundredths?')) { S.settings = { ...S.settings, timingUnit: 'cent' }; saveSettings(S.settings); }
        if (res.failedPages.length && !confirm(`Page${res.failedPages.length > 1 ? 's' : ''} ${res.failedPages.join(', ')} could not be fully read. Check the ${res.instructions.length} instructions read so far? (Cancel stays here so you can read those pages again.)`)) return;
        if (res.instructions.length) location.hash = '#verify';
      } catch (e) { alert(`Reading failed: ${e.message}`); }
    },
  });
}

function showVerify() {
  app.append(topbar('Driver verifies'));
  const box = h('div', {}); app.append(box);
  const ins = S.route?.instructions || [];
  S.view = mountVerify(box, {
    instructions: ins, flags: checksFor(ins), pages: S.pages.map((p) => ({ page: p.page, url: p.url, w: p.w, h: p.h })), legs: computeLegs(ins), digest: S.route?.digest ?? null,
    onEdit: (n, patch) => {
      const list = S.route.instructions.map((r) => (r.n !== n ? r : patch.text !== undefined ? reparse(r, patch.text) : { ...r, ...patch, verified: false }));
      setRoute(list);
      S.view.update({ instructions: S.route.instructions, flags: checksFor(S.route.instructions) });
    },
    onVerify: (n, ok) => {
      const list = S.route.instructions.map((r) => (r.n === n ? { ...r, verified: ok } : r));
      setRoute(list);
      S.view.update({ instructions: S.route.instructions, flags: checksFor(S.route.instructions) });
      store.set('verify_stats', S.view.stats?.());
    },
    onDone: () => { location.hash = '#home'; },
  });
}

function showSettings() {
  app.append(topbar('Settings'));
  const box = h('div', {}); app.append(box);
  S.view = mountSettings(box, {
    settings: S.settings, status: S.status,
    onChange: (patch) => {
      S.settings = { ...S.settings, ...patch }; saveSettings(S.settings);
      voice.enabled = S.settings.voice; voice.rate = S.settings.voiceRate;
      if (live) { live.settings = S.settings; live.rebuild(); }
    },
    actions: {
      connectRaceBox, connectObd: () => alert('OBD is not wired in this version (RaceBox + tablet GPS are).'),
      testVoice: () => voice.speak('In point three, right at the T onto Smith Road.'),
      testMark: () => alert(`Press the Bluetooth button now; last key seen: ${S.status.lastKey || 'none'}`),
    },
  });
  S.timer = setInterval(() => S.view?.update?.({ settings: S.settings, status: { ...S.status } }), 1000);
}

function showDrive() {
  ensureLive(); startSensors(); keepAwake();
  const driverOnly = new URLSearchParams(location.search).get('driver') === '1';
  const startBtn = h('button', { onclick: () => { if (!live.started) live.action('start'); startBtn.remove(); } }, 'START (at the start line)');
  S.mapOn ??= store.get('mapOn', false);
  const mapBtn = h('button', { onclick: () => setMap(!S.mapOn) }, 'Map');
  const extras = [...(driverOnly ? [] : [mapBtn]), h('button', { onclick: connectRaceBox }, 'RaceBox'), h('button', { onclick: () => document.documentElement.requestFullscreen?.() }, '⤢')];
  if (!live.started) extras.unshift(startBtn);
  app.append(topbar('Drive', extras));
  const grid = h('div', { class: `drive${driverOnly ? ' driver-only' : ''}` });
  const dEl = h('div', {}), nEl = h('div', { class: 'navpane' });
  grid.append(dEl, nEl); app.append(grid);
  const driver = mountDriver(dEl, { unit: S.settings.timingUnit });
  const digest = S.route?.digest ?? null;
  const nav = mountNavigator(nEl, { instructions: live.schedule.rows, table: live.schedule.table(), unit: S.settings.timingUnit, digest,
    onAction: (name, p) => { live.action(name, p); nav.setRoute(live.schedule.rows, live.schedule.table(), digest); } });
  // The map, under the driver's numbers (Map / Hide map in the top bar); the list and controls stay.
  const mEl = h('div', { class: 'mp-pane', hidden: true });
  dEl.append(mEl);
  let map = null;
  function setMap(on) {
    S.mapOn = on; store.set('mapOn', on);
    if (on && !map) map = mountMap(mEl);
    mEl.hidden = !on;
    grid.classList.toggle('with-map', on);
    mapBtn.textContent = on ? 'Hide map' : 'Map';
    if (on && live.state) map.update(live.state, live);
  }
  if (S.mapOn && !driverOnly) setMap(true);
  S.view = { destroy: () => { driver.destroy(); nav.destroy(); map?.destroy(); } };
  let k = 0;
  S.driving = true;
  S.timer = setInterval(() => {
    const st = live.tick();
    driver.update(st); nav.update(st);
    if (map && S.mapOn) map.update(st, live);
    if (++k % 10 === 0) {
      saveLive();
      nav.setLog(live.log.slice(-200).reverse());
    }
  }, 100);
}
function saveLive() { store.set('live', { ...live.snapshot(), routeSavedAt: S.route?.savedAt }); }
// Away from the Drive screen (Home, Verify, Log) a started rally keeps running: voice cues, route
// progress and the crash-safe save don't depend on which screen is open.
let bgK = 0;
setInterval(() => {
  if (!live?.started || S.driving) return;
  live.tick();
  if (++bgK % 10 === 0) saveLive();
}, 100);

// The rally as one text file: settings, every logged event, checkpoint scores and a 1 s GPS track. For
// the crew's own review, or as evidence if a control's score is questioned.
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
function logText() {
  const st = S.settings, e = live?.engine;
  return [
    `Rally Computer log, saved ${new Date().toString()}`,
    `Car ${st.carNumber} · car 0 starts ${st.baseStart} · timing in ${st.timingUnit === 'cent' ? 'hundredths' : 'seconds'} · TA up to ${mmss(st.taMax_s ?? 1170)} · Richta controls: ${st.legStyle === 'control' ? 'each starts a new leg' : 'timing carries on from the restart'}`,
    `Route: ${S.route?.instructions?.length ?? 0} instructions (${S.route?.source ?? 'unknown source'}), last changed ${S.route?.savedAt ? new Date(S.route.savedAt).toLocaleString() : '—'}`,
    `Odometer factor: ${e?.calibrated ? e.K.toFixed(5) : 'not calibrated'} · clock ${clock.synced ? `synced to the master clock (${clock.ref})` : 'not synced to the master clock'}`,
    '', '--- Events (rally time)', ...(live?.log || []).map((x) => `${fmtTod(x.t_s)}  ${x.text}`),
    '', '--- Checkpoints scored by this app', ...(live?.cpErrors || []).map((c) => `#${c.n}  ${c.D.toFixed(2)} mi  ${c.err >= 0 ? '+' : ''}${c.err.toFixed(1)} s`),
    '', '--- Distance engine (seconds since the app started)', ...(e?.log || []).map((x) => `${x.t.toFixed(1)}  ${x.text}`),
    '', '--- GPS track, one point a second: UTC time, latitude, longitude, mph, route miles',
    ...(live?.track || []).map(([u, la, lo, v, D]) => `${u ? new Date(u).toISOString() : ''},${la},${lo},${v ?? ''},${D}`),
  ].join('\n');
}
const logName = () => { const d = new Date(), p = (x) => String(x).padStart(2, '0'); return `rally-log-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.txt`; };
function saveLogFile() {
  const a = h('a', { href: URL.createObjectURL(new Blob([logText()], { type: 'text/plain' })), download: logName() });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
async function shareLogFile() {
  try { await navigator.share({ files: [new File([logText()], logName(), { type: 'text/plain' })], title: 'Rally log' }); } catch { /* cancelled */ }
}
const canShareFiles = () => { try { return !!navigator.canShare?.({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] }); } catch { return false; } };

function showLog() {
  app.append(topbar('Log', [h('button', { onclick: saveLogFile }, 'Save file'), ...(canShareFiles() ? [h('button', { onclick: shareLogFile }, 'Share')] : [])]));
  const lines = (live?.log || []).map((e) => `${fmtTod(e.t_s)}  ${e.text}`).join('\n');
  const eng = (live?.engine.log || []).map((e) => `${e.t.toFixed(1)}  ${e.text}`).join('\n');
  app.append(h('div', { class: 'log' }, lines || 'No events yet.', '\n\n— distance engine —\n', eng || '—', '\n\n— voice —\n',
    voice.log.slice(-50).map((e) => `${new Date(e.t).toLocaleTimeString()}  ${e.text}`).join('\n')));
}

// Time table: the expected times from the instructions, segment by segment (also the paper backup).
function showPaper() {
  ensureLive();
  app.append(topbar('Time table', [h('button', { onclick: () => print() }, 'Print')]));
  const st = S.settings, box = h('div', {});
  app.append(box);
  const segs = segmentTable(S.route?.instructions || [], { startTod: clockStart(), carNumber: st.carNumber, marks: live.ev.marks, live: live.ev });
  renderTimes(box, segs, { unit: st.timingUnit, carNumber: st.carNumber, tas: live.ev.tas.length });
}

// Pre-rally device check: everything the car setup depends on, in plain words.
async function diagLines() {
  const L = [];
  const ua = navigator.userAgent;
  const chrome = (ua.match(/Chrome\/(\d+)/) || [])[1];
  L.push(`Browser: ${chrome ? `Chrome ${chrome}` : 'not Chrome'} on ${/Android/.test(ua) ? 'Android' : /iPhone|iPad|Macintosh/.test(ua) ? 'Apple' : 'desktop'}`);
  L.push(`Installed as an app: ${matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches ? 'yes' : 'no (Chrome menu → Install app)'}`);
  L.push(`Offline copy: ${navigator.serviceWorker?.controller ? 'ready' : 'not active yet (open once online, then reload)'}`);
  L.push(`Web Bluetooth: ${'bluetooth' in navigator ? 'yes' : 'NO: the RaceBox cannot connect from this browser'}`);
  if (navigator.bluetooth?.getAvailability) L.push(`Bluetooth radio available: ${await navigator.bluetooth.getAvailability() ? 'yes' : 'no (turn Bluetooth on)'}`);
  L.push(`RaceBox reconnect after restart without the chooser: ${navigator.bluetooth?.getDevices ? 'yes' : 'no (tap RaceBox after a restart)'}`);
  L.push(`Web Serial (only for Bluetooth Classic OBD adapters): ${'serial' in navigator ? 'yes' : 'no'}`);
  try { L.push(`Location permission: ${(await navigator.permissions.query({ name: 'geolocation' })).state}`); } catch { L.push('Location permission: unknown'); }
  L.push(`Keep screen awake: ${'wakeLock' in navigator ? 'yes' : 'no (set the screen timeout to its maximum)'}`);
  try { const b = await navigator.getBattery?.(); if (b) L.push(`Battery: ${Math.round(b.level * 100)}%, ${b.charging ? 'charging' : 'NOT charging: plug in the 12 V charger'}`); } catch { /* not available */ }
  const off = -new Date().getTimezoneOffset() / 60;
  L.push(`Local time: ${new Date().toLocaleTimeString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone}, UTC${off >= 0 ? '+' : ''}${off}). Check it matches the official clock to the minute.`);
  L.push(`Time allowance: Richta steps up to ${mmss(S.settings.taMax_s ?? 1170)} per leg · Richta controls: ${S.settings.legStyle === 'control' ? 'each starts a new leg' : 'timing carries on from the restart'} (Settings, from the GIs)`);
  L.push('Richta (if the GIs use it): on the phone, not this tablet. Register at check-in (Unregister an old event first); keep it open, on screen and plugged in; phone Bluetooth off so its chime plays. A backup device uses car number + 100.');
  const voices = await new Promise((res) => {
    const v = speechSynthesis?.getVoices?.() || [];
    if (v.length) return res(v);
    speechSynthesis?.addEventListener?.('voiceschanged', () => res(speechSynthesis.getVoices()), { once: true });
    setTimeout(() => res(speechSynthesis?.getVoices?.() || []), 1500);
  });
  const en = voices.filter((v) => /^en/i.test(v.lang));
  const local = en.filter((v) => v.localService);
  L.push(`Voices: ${en.length} English, ${local.length} on-device${local.length ? ` (${local.slice(0, 2).map((v) => v.name).join(', ')})` : ' — check in airplane mode that cues still speak'}`);
  if (navigator.storage?.persisted) {
    const p = await navigator.storage.persisted();
    const est = await navigator.storage.estimate?.();
    L.push(`Storage kept when space is low: ${p ? 'yes' : 'not yet (installing the app usually grants it)'}${est ? ` · using ${(est.usage / 1e6).toFixed(1)} MB` : ''}`);
  }
  const n = S.route?.instructions?.length || 0;
  L.push(`Route: ${n ? `${n} instructions, ${verifiedCount()} verified` : 'none loaded'}`);
  L.push(`Sensors: RaceBox ${S.status.racebox}, tablet GPS ${S.status.gps}; last button key: ${S.status.lastKey || 'none yet'}`);
  L.push(`Clock: ${clock.synced ? `synced to master (${(clock.masterMinusRef / 1000).toFixed(2)} s vs ${clock.ref})` : 'not synced to the master clock yet'}`);
  return L;
}
function showDiag() {
  const out = h('div', { class: 'log' }, 'Checking…');
  const run = async () => { out.textContent = (await diagLines()).join('\n'); };
  app.append(topbar('Device check', [
    h('button', { onclick: run }, 'Re-check'),
    h('button', { onclick: () => voice.speak('Three late. In point three, right at the T onto Smith Road.') }, 'Test voice'),
    h('button', { onclick: async () => { await navigator.storage?.persist?.(); run(); } }, 'Keep storage'),
  ]));
  app.append(out);
  run();
  S.timer = setInterval(run, 3000);
}

function route() {
  teardown();
  const hash = location.hash || '#home';
  ({ '#scan': showScan, '#verify': showVerify, '#settings': showSettings, '#drive': showDrive, '#log': showLog, '#paper': showPaper, '#diag': showDiag }[hash] || showHome)();
}
navigator.storage?.persist?.().catch(() => {});
window.addEventListener('hashchange', route);
route();

// Resume straight into driving after a crash or restart mid-rally (A9).
if (store.get('live', null)?.started && location.hash !== '#drive') { location.hash = '#drive'; }

// Offline cache. On a localhost dev server it is off unless ?sw=1 (so edits show up immediately).
const devHost = ['localhost', '127.0.0.1'].includes(location.hostname);
if ('serviceWorker' in navigator) {
  if (!devHost || new URLSearchParams(location.search).has('sw')) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('service worker', e));
  else navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister()));
}

// For the dev replay harness.
window.__rally = { get live() { return ensureLive(); }, store, clock, S };
if (new URLSearchParams(location.search).has('replay')) import('../dev/replay.js');
