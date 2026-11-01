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
import { RichtaListener } from './app/listen.js';
import { GLOSSARY, HINTS } from './app/glossary.js';

const app = document.getElementById('app');
const S = {
  settings: loadSettings(),
  route: store.get('route', null),          // { instructions, pageRowCounts, extraFlags, source, savedAt }
  pages: [],                                 // photos for the verify screen (memory only)
  status: { racebox: 'off', obd: 'off', gps: 'off', lastKey: '' },
  view: null, timer: null,
};
const clock = new RallyClock(store.get('clock', null));
const voice = new Voice({ enabled: S.settings.voice, rate: S.settings.voiceRate, name: S.settings.voiceName });

// Hear Richta: the tablet's microphone taps RICHTA BEEPED when it hears the beep it learned at check-in.
const listener = new RichtaListener({
  isSpeaking: () => typeof speechSynthesis !== 'undefined' && speechSynthesis.speaking,
  onBeep: () => {
    ensureLive();
    voice.speak('Heard Richta.', { alert: false });
    const n0 = live.log.length;
    live.action('richta', { via: 'mic' });
    const fresh = live.log.slice(n0);
    if (fresh.length) S.navApi?.toast(`🎤 Heard Richta. ${fresh[fresh.length - 1].text}`);
  },
});
// Off for now: on the road (2026-11-01) it heard beeps that weren't Richta's. The navigator taps instead.
const HEAR_RICHTA = false;
function syncListener() {
  const want = HEAR_RICHTA && S.settings.listenRichta && S.settings.richtaSound && RichtaListener.supported();
  if (want && !listener.listening) listener.start(S.settings.richtaSound).catch((e) => { console.warn('microphone', e); S.status.mic = `off: ${e.message}`; });
  else if (!want && listener.listening) listener.stop();
}
document.addEventListener('pointerdown', () => listener.resume(), { passive: true });
function learnRichtaSheet() {
  const msg = h('p', {}, 'Put the phone with Richta right next to the tablet, volume up. Tap Start, then run Richta’s Sound Check (or make Richta beep a few times) within 15 seconds.');
  const bar = h('div', { class: 'bar' }, h('i', {}));
  const back = h('div', { class: 'sheet-back' });
  const close = () => { back.remove(); route(); };
  const startBtn = h('button', { class: 'btn-primary', onclick: async () => {
    startBtn.disabled = true; msg.textContent = 'Listening… run Richta’s Sound Check now.';
    try {
      const sound = await listener.learn(15, (f) => { bar.firstChild.style.width = `${Math.round(f * 100)}%`; });
      if (sound) {
        S.settings = { ...S.settings, richtaSound: sound, listenRichta: true }; saveSettings(S.settings); syncListener();
        msg.textContent = `Learned Richta’s beep (${sound.tones.map((t) => `${(t / 1000).toFixed(1)} kHz`).join(', ')}). Hear Richta is on: the tablet taps RICHTA BEEPED when it hears it, and says "Heard Richta".`;
      } else msg.textContent = 'No clear beep heard. Turn the phone’s volume up, put it closer, and try again.';
    } catch (e) { msg.textContent = `The microphone didn’t start (${e.message}). Allow the microphone for this app, then try again.`; }
    startBtn.disabled = false; startBtn.textContent = 'Try again';
  } }, 'Start');
  back.append(h('div', { class: 'sheet' }, h('h2', {}, 'Learn Richta’s beep'), msg, bar, h('div', { class: 'row', style: { marginTop: '12px' } }, startBtn, h('button', { onclick: close }, 'Close'))));
  document.body.append(back);
}
// Hints and Glossary on the Drive screen: a list over the screen, closed by Close or a tap outside it.
function infoSheet(title, items) {
  const back = h('div', { class: 'sheet-back', onclick: (e) => { if (e.target === back) back.remove(); } });
  back.append(h('div', { class: 'sheet' }, h('h2', {}, title),
    h('ul', { class: 'help-list' }, items.map(([t, d]) => h('li', {}, h('b', {}, t), ` ${d}`))),
    h('div', { class: 'row', style: { marginTop: '12px' } }, h('button', { class: 'btn-primary', onclick: () => back.remove() }, 'Close'))));
  document.body.append(back);
}
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
      h('button', { onclick: () => { location.hash = '#help'; } }, 'How it works'),
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
      if ('voiceName' in patch) voice.setName(S.settings.voiceName);
      if ('theme' in patch) applyTheme();
      if (live) { live.settings = S.settings; live.rebuild(); }
    },
    actions: {
      connectRaceBox, connectObd: () => alert('OBD is not wired in this version (RaceBox + tablet GPS are).'),
      testVoice: () => voice.speak('In 500 yards, turn right at the T onto Smith Road. Drive 44. 3 seconds late.'),
      testMark: () => alert(`Press the Bluetooth button now; last key seen: ${S.status.lastKey || 'none'}`),
    },
  });
  S.timer = setInterval(() => S.view?.update?.({ settings: S.settings, status: { ...S.status } }), 1000);
}

function showDrive() {
  ensureLive(); startSensors(); keepAwake();
  const driverOnly = new URLSearchParams(location.search).get('driver') === '1';
  const simple = (S.settings.navMode ?? 'simple') === 'simple';
  const startBtn = h('button', { onclick: () => { if (!live.started) live.action('start'); startBtn.remove(); } }, 'START (at the start line)');
  S.mapOn ??= store.get('mapOn', true);
  const mapBtn = h('button', { onclick: () => setMap(!S.mapOn) }, 'Map');
  const extras = [...(HEAR_RICHTA && S.settings.listenRichta && S.settings.richtaSound ? [h('span', { class: 'badge good' }, '🎤 Hearing Richta')] : []),
    ...(driverOnly ? [] : [h('button', { onclick: () => infoSheet('Hints', HINTS) }, 'Hints'), h('button', { onclick: () => infoSheet('Glossary: rally words', GLOSSARY) }, 'Glossary'), mapBtn]),
    h('button', { onclick: connectRaceBox }, 'Connect RaceBox'), h('button', { onclick: () => document.documentElement.requestFullscreen?.() }, 'Full screen')];
  if (!live.started && !simple) extras.unshift(startBtn);   // simple mode has its own big START
  app.append(topbar('Drive', extras));
  const grid = h('div', { class: `drive${driverOnly ? ' driver-only' : ''}` });
  const dEl = h('div', {}), nEl = h('div', { class: 'navpane' });
  grid.append(dEl, nEl); app.append(grid);
  const driver = mountDriver(dEl, { unit: S.settings.timingUnit });
  const digest = S.route?.digest ?? null;
  const setSetting = (k, v) => { S.settings[k] = v; saveSettings(S.settings); };
  const THEMES = [['dark', 'Dark'], ['day', 'Daylight'], ['contrast', 'High contrast'], ['bridge', 'Covered bridge']];
  const moreItems = [
    { label: 'Change colours', note: `Now: ${THEMES.find((t) => t[0] === (S.settings.theme ?? 'dark'))?.[1] ?? 'Dark'}. Next: Daylight for bright sun, High contrast, Covered bridge.`,
      run: () => { const i = THEMES.findIndex((t) => t[0] === (S.settings.theme ?? 'dark')); setSetting('theme', THEMES[(i + 1) % THEMES.length][0]); applyTheme(); } },
    { label: simple ? 'Show all controls' : 'Simple controls', note: simple ? 'Every button at once, for an experienced navigator.' : 'Back to the six big buttons.',
      run: () => { setSetting('navMode', simple ? 'full' : 'simple'); route(); } },
    ...(HEAR_RICHTA ? [{ label: 'Hear Richta: learn its beep', note: 'At check-in: the tablet learns Richta’s beep from its Sound Check (15 seconds).', run: learnRichtaSheet }] : []),
    ...(HEAR_RICHTA && S.settings.richtaSound ? [{ label: S.settings.listenRichta ? 'Hear Richta: turn off' : 'Hear Richta: turn on',
      note: S.settings.listenRichta ? 'Stop listening. Turn it off if the car speakers start acting like a phone call.' : 'The tablet listens and taps RICHTA BEEPED for you; you can still tap it.',
      run: () => { setSetting('listenRichta', !S.settings.listenRichta); syncListener(); route(); } }] : []),
  ];
  const nav = mountNavigator(nEl, { instructions: live.schedule.rows, table: live.schedule.table(), unit: S.settings.timingUnit, digest,
    mode: simple ? 'simple' : 'full', startTod: clockStart(), moreItems,
    onAction: (name, p) => {
      const n0 = live.log.length;
      live.action(name, p);
      nav.setRoute(live.schedule.rows, live.schedule.table(), digest);
      const fresh = live.log.slice(n0);
      if (fresh.length) nav.toast(`✓ ${fresh[fresh.length - 1].text}`);
    } });
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
  S.navApi = nav;
  syncListener();
  S.view = { destroy: () => { S.navApi = null; driver.destroy(); nav.destroy(); map?.destroy(); } };
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
// How it works: the full instructions, most important first. Also printable (Print in the top bar).
function showHelp() {
  app.append(topbar('How it works', [h('button', { onclick: () => print() }, 'Print')]));
  const sec = (title, items, { ol = false, note = null } = {}) => h('div', { class: 'panel' }, h('h2', {}, title), ...(note ? [h('p', { class: 'muted' }, note)] : []),
    h(ol ? 'ol' : 'ul', { class: 'help-list' }, items.map((x) => h('li', {}, ...(Array.isArray(x) ? x : [x])))));
  const b = (t) => h('b', {}, t);
  app.append(h('div', { class: 'screen help' },
    h('p', { class: 'muted' }, 'Read part 1 together before the start. The rest is in order of importance: the further down, the less you’ll need it.'),
    sec('1 · The six things that matter most', [
      [b('The paper instructions are the boss.'), ' The app is a helper. If it disagrees with the paper, follow the paper.'],
      [b('Keep both screens on and plugged in:'), ' this app on the tablet, on the Drive screen, and Richta on the phone. Don’t switch apps or press the power button: the tablet pauses an app that’s off screen.'],
      [b('Read the line at the top of the middle.'), ' It always says what to do now: what to tell the driver, how far ahead, and what speed. The voice says the same.'],
      [b('Every time Richta beeps, tap RICHTA BEEPED.'), ' No rush: a few seconds late is fine. At each restart gate, tap it as you cross, even if Richta stays quiet.'],
      [b('MARK exactly at the end of the odometer check.'), ' This is the one tap that has to be on the spot. If it ends at a STOP sign, tap while you’re stopped there.'],
      [b('Pressed something by mistake? UNDO.'), ' It takes back the last tap.']], { ol: true }),
    sec('2 · Before you leave home (needs internet)', [
      [b('Update the app:'), ' open it, close it, open it again. This page should then start with “The six things that matter most”.'],
      [b('Clear last night’s test:'), ' Home → Reset rally state → OK. Your settings stay.'],
      [b('Settings → Rally:'), ' your car number, and “Car 0 starts at” 11:00:00 (car 1 starts at 11:01).'],
      [b('Settings → Voice:'), ' Test voice. Pick the clearest one under Voice.'],
      [b('Charge'), ' the tablet, the phone and the RaceBox, and bring the car chargers.']]),
    sec('3 · Practice run near the start (optional, about 30 minutes)', [
      [b('Load it:'), ' Home → Read → Load the practice route. Then Home → Drive.'],
      [b('Get to the start:'), ' from the Burger King, drive east on Gateway Avenue (away from Route 7) to its end at Dorman Road, and stop.'],
      [b('START'), ' as you turn right onto Dorman Road. The odometer check runs 3.14 miles to the T at Furnace Road: stop there and tap MARK.'],
      [b('Restart at Furnace Road:'), ' wait for the clock to show :00, turn right, and tap RICHTA BEEPED.'],
      [b('No Richta in practice:'), ' tap RICHTA BEEPED as you reach each CHECKPOINT line; the top line counts down to it.'],
      [b('Three segments,'), ' about 11 miles in all, then right (north) on Route 7, about 3 miles back to the Burger King.'],
      [b('Afterwards:'), ' Home → Reset rally state. Your real instructions replace the practice route when you load them.'],
      [b('Not driven yet:'), ' it’s built from map data. If a road or sign doesn’t match, skip that part.']]),
    sec('4 · At check-in', [
      [b('The clocks went back an hour at 2 a.m. today.'), ' Check the tablet and the phone show the right time.'],
      [b('Sync the clock:'), ' Home → Sync now, tapped exactly as the master clock rolls over to a new minute.'],
      [b('Richta, on the phone:'), ' unregister any old event, register this one with your car number, run its Sound Check. Volume up, phone Bluetooth off so the beep plays out loud.'],
      [b('RaceBox:'), ' switch it on. Settings → Sensors → Connect RaceBox, or later the Connect RaceBox button at the top of the Drive screen.']]),
    sec('5 · Getting the instructions into the app (as soon as you get them)', [
      [b('Type them:'), ' Home → Read → “Type or paste instructions”. One instruction per line, as printed: number, mileage, then the words, e.g. “12 4.35 R at T onto Smith Rd”. No mileage printed? Leave it out: “13 R onto Oak St”. Then Use this text.'],
      [b('Or photograph them,'), ' only with the rallymaster’s written OK: it needs internet and your API key (Settings → Reading profile → Cloud reading). Read → Pick from files → select every page → Read pages. About 3 minutes for 22 pages.'],
      [b('The driver checks every line'), ' (Home → Verify) against the paper. Under each line is what it means in plain English. Fix anything that doesn’t match, then Done. Watch the CAST speeds (CAST = the average speed to drive), the mileages, and that each restart line reads “Restart…”.'],
      [b('Time table'), ' (Home): each segment’s times. A total that looks wrong (say 20 minutes for 3 miles) means a misread line: fix it. Print it if you can; it’s the paper backup.'],
      [b('From the general instructions (GIs), in Settings → Rally:'), ' timing unit (seconds or hundredths), the largest time allowance (9:30 or 19:30). Keep “Timing carries on from the restart”.'],
      [b('Hear Richta (optional):'), ' Drive → MORE → Hear Richta: learn its beep, then run Richta’s Sound Check with the phone next to the tablet. After that the tablet taps RICHTA BEEPED for you and says “Heard Richta”. You can still tap it yourself.']]),
    sec('6 · The start', [
      [b('Home → Drive.'), ' Tap Full screen at the top.'],
      [b('The voice counts down:'), ' “One minute to your start”, “Thirty seconds”, “Ten seconds”, “Five”, “Go”.'],
      [b('Tap START as you leave the start line'), ' (or RICHTA BEEPED if Richta beeps). Forgot? It starts by itself when you drive off near your start time. A late tap is fine: it counts from where you pulled away.'],
      [b('Odometer check:'), ' usually first. MARK exactly at its end (part 1).'],
      [b('Time alignment:'), ' if the timing starts at a restart away from the meeting point, drive there by the instructions, leave it at your time, and tap RICHTA BEEPED as you cross it.']]),
    sec('7 · Driving a segment', [
      [b('Navigator:'), ' read the top line to the driver, for example “In 700 yards: Turn RIGHT onto Smith Rd. Speed up to 44 (now 42). 4 s late.” The voice calls the turns and speeds too.'],
      [b('Driver:'), ' the big number on the left is how many seconds LATE or EARLY you are (green near zero). Under it is the speed to drive. Never go over the speed limit.'],
      [b('“Watch for: …”'), ' is an instruction with no mileage, like a sign. Tap MARK as you pass it.'],
      [b('Pause (“GO IN 0:20”):'), ' stop and wait. The app counts down and says GO.'],
      [b('Held up'), ' by something you couldn’t help (train, tractor, school bus, a slow car, waiting at a one-lane bridge)? Tap DELAY right away, tap the green total, then press TA+ in Richta the number of times shown. Later is too late: the checkpoints are hidden.'],
      [b('Speed limit signs (optional):'), ' MORE → tap the limit. The app never asks for more than that.']]),
    sec('8 · End of a segment, and the restart', [
      [b('“Segment done: no timing now”:'), ' you can stop and enjoy the bridge. The app stays quiet until the restart. It says this after the segment’s last checkpoint. A beep with more of the segment still ahead is just logged and the timing goes on; if you then stand still for a minute near it, the app takes it as the segment’s end.'],
      [b('The top line shows the restart:'), ' a countdown to its time, or “leave on any whole minute, crossing just after :00”.'],
      [b('Leave on time and tap RICHTA BEEPED as you cross the restart gate.'), ' It says “Segment started. Timing from 11 42” (or “Restart counted at 11 42” when it went by the mileage). Check that matches Richta’s out time. If it doesn’t: MORE → Restart time.'],
      [b('Each segment starts fresh:'), ' being late in one doesn’t carry into the next.']]),
    sec('9 · If something goes wrong', [
      [b('Wrong tap:'), ' UNDO.'],
      [b('“Missed turn?”:'), ' the top line says how to get back: turn around when safe, drive back, then make the turn. Tap BACK ON ROUTE as you make it.'],
      [b('“Off the route?” (from the map):'), ' check the last instruction. If you did turn wrong, go back to the pink line and tap BACK ON ROUTE there. If not, ignore it.'],
      [b('Took a wrong road and nothing says so:'), ' MORE → Off course. When you’re back where you left the route: MORE → Back on course. The extra miles come off.'],
      [b('“The app was paused”'), ' (the tablet slept or another app came up): keep going; it fixes itself at the next turn. Faster: tap the instruction you’re passing in the list, then We’re here.'],
      [b('The app closed:'), ' open it again. It carries on where it was.'],
      [b('“No GPS signal”:'), ' check the RaceBox is on, then Connect RaceBox at the top.'],
      [b('“Odometer check looks wrong”:'), ' if MARK was tapped at the wrong place, UNDO.'],
      [b('The app seems lost:'), ' drive by the paper and the Time table. It catches up at the next turn, or with We’re here.']]),
    sec('10 · The Drive screen, piece by piece', [
      [b('Left, top:'), ' the big number and LATE / EARLY / ON TIME. Under it: the speed to drive and the next instruction.'],
      [b('Left, bottom: the map.'), ' It turns with the car. Green line: where you’ve been. Blue road: where the next turn goes. Pink line: the app’s guess at the route, with how sure it is (%), dashed when unsure. Trust the instructions over the map.'],
      [b('Middle:'), ' at the top, what to do now. Under it, the instructions; the highlighted one is next, with the time you should get there.'],
      [b('Right:'), ' the six buttons. RICHTA BEEPED, MARK, DELAY, START (later BACK ON ROUTE), UNDO, MORE.'],
      [b('Top bar:'), ' ‹ Home, Hints, Glossary, Hide map, Connect RaceBox, Full screen. “🎤 Hearing Richta” shows when the tablet is listening.']]),
    sec('11 · The MORE menu (now and then)', [
      [b('Speed limit sign:'), ' 25, 35, 45, 55 or other.'],
      [b('End odo check:'), ' only if MARK didn’t catch the end of the odometer check, tapped right at its end.'],
      [b('Off course / Back on course:'), ' see part 9.'],
      [b('Restart time:'), ' fix a restart time that doesn’t match Richta’s.'],
      [b('Staffed control:'), ' only if a person at a control gives you an out time.'],
      [b('Rules:'), ' the special rules read from the general instructions.'],
      [b('Change colours:'), ' Dark, Daylight (bright sun), High contrast, Covered bridge.'],
      [b('Show all controls / Simple controls:'), ' every button at once, or back to the six big ones.'],
      [b('Hear Richta:'), ' learn its beep, or turn listening on and off. Turn it off if the car speakers start acting like a phone call.']]),
    sec('12 · After the finish', [
      [b('Home → Log → Save file.'), ' It keeps everything that happened and a GPS track, in case a score is questioned.']]),
    sec('13 · Settings (set once)', [
      [b('Rally:'), ' car number, “Car 0 starts at”, the default speed limit, timing unit, largest time allowance, and what a Richta control does (keep “carries on”).'],
      [b('Voice:'), ' speed, which voice, Test voice.'],
      [b('Screen:'), ' colours, and Simple or All controls.'],
      [b('Reading profile:'), ' Offline (type the instructions) or Cloud (photographs, only with the rallymaster’s written OK).'],
      [b('Sensors:'), ' RaceBox and the tablet’s GPS. Home → Device check tests Bluetooth, location, battery and the voice.']]),
    sec('14 · Glossary: rally words', GLOSSARY.map(([t, d]) => [b(t), ` ${d}`])),
    sec('15 · Hints', HINTS.map(([t, d]) => [b(t), ` ${d}`]))));
}

function showDiag() {
  const out = h('div', { class: 'log' }, 'Checking…');
  const run = async () => { out.textContent = (await diagLines()).join('\n'); };
  app.append(topbar('Device check', [
    h('button', { onclick: run }, 'Re-check'),
    h('button', { onclick: () => voice.speak('3 seconds late. In 500 yards, turn right at the T onto Smith Road.') }, 'Test voice'),
    h('button', { onclick: async () => { await navigator.storage?.persist?.(); run(); } }, 'Keep storage'),
  ]));
  app.append(out);
  run();
  S.timer = setInterval(run, 3000);
}

// Colours: Dark, Daylight (bright sun), High contrast, Covered bridge (autumn).
function applyTheme() { document.documentElement.dataset.theme = S.settings.theme || 'dark'; }

function route() {
  teardown();
  applyTheme();
  const hash = location.hash || '#home';
  ({ '#scan': showScan, '#verify': showVerify, '#settings': showSettings, '#drive': showDrive, '#log': showLog, '#paper': showPaper, '#diag': showDiag, '#help': showHelp }[hash] || showHome)();
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
