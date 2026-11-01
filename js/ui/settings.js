// Settings screen.
import { h, clear } from './dom.js';

export function mountSettings(container, opts) {
  const { onChange = () => {}, actions = {} } = opts;
  let settings = { ...(opts.settings || {}) };
  let status = { ...(opts.status || {}) };
  let showKey = false;
  const root = h('div', { class: 'screen settings' });
  container.appendChild(root);

  const set = (k, v) => { settings[k] = v; onChange({ [k]: v }); };

  function seg(key, options) {
    return h('div', { class: 'seg' }, options.map(([val, label]) =>
      h('button', { 'aria-pressed': String(settings[key] === val), onclick: () => { set(key, val); render(); } }, label)));
  }
  // Time of day "HH:MM" or "HH:MM:SS" (base start time of the first car).
  function tod(key, label) {
    const inp = h('input', { type: 'text', inputmode: 'numeric', value: settings[key] || '', 'aria-label': label, placeholder: '11:00' });
    inp.addEventListener('change', () => {
      const m = inp.value.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      if (!m || +m[1] > 23 || +m[2] > 59) { inp.value = settings[key] || ''; return; }
      const v = `${m[1].padStart(2, '0')}:${m[2]}:${m[3] || '00'}`;
      inp.value = v;
      set(key, v);
    });
    return h('label', { class: 'row' }, h('span', { class: 'grow' }, label), inp);
  }
  function num(key, label, o = {}) {
    const inp = h('input', { type: 'text', inputmode: 'decimal', value: settings[key] == null ? '' : String(settings[key]), 'aria-label': label });
    inp.addEventListener('change', () => {
      let v = Number(inp.value);
      if (inp.value.trim() === '' || Number.isNaN(v)) { inp.value = settings[key] ?? ''; return; }
      if (o.min != null) v = Math.max(o.min, v);
      if (o.max != null) v = Math.min(o.max, v);
      if (o.int) v = Math.round(v);
      inp.value = String(v);
      set(key, v);
    });
    return h('div', null, h('label', null, label), inp);
  }
  function range(key, label, min, max, step) {
    const out = h('b', { class: 'num' }, String(settings[key] ?? min));
    const inp = h('input', { type: 'range', min, max, step, value: String(settings[key] ?? min), 'aria-label': label, style: { width: '100%', minHeight: '56px' } });
    inp.addEventListener('input', () => { out.textContent = inp.value; });
    inp.addEventListener('change', () => set(key, Number(inp.value)));
    return h('div', null, h('label', null, label, ' · ', out), inp);
  }
  const act = name => () => { if (typeof actions[name] === 'function') actions[name](); };
  const line = (label, val) => h('div', { class: 'row' }, h('b', { style: { minWidth: '90px' } }, label), h('span', { class: 'muted grow' }, val || '—'));

  function render() {
    clear(root);
    const key = h('input', { type: showKey ? 'text' : 'password', value: settings.apiKey || '', autocomplete: 'off', 'aria-label': 'API key', placeholder: 'sk-…' });
    key.addEventListener('change', () => set('apiKey', key.value));
    root.append(
      h('h1', null, 'Settings'),
      h('div', { class: 'panel' },
        h('h2', null, 'Reading profile'),
        seg('profile', [['offline', 'Offline reading'], ['cloud', 'Cloud reading']]),
        settings.profile === 'cloud' ? h('div', { class: 'flag watch', style: { marginTop: '10px' } }, "Use only with the rallymaster's written OK.") : null,
        settings.profile === 'cloud' ? h('div', null,
          h('label', null, 'API key'),
          h('div', { class: 'row' }, h('div', { class: 'grow' }, key),
            h('button', { onclick: () => { settings.apiKey = key.value; showKey = !showKey; render(); } }, showKey ? 'Hide' : 'Show')),
          h('div', { class: 'muted', style: { fontSize: '.9rem', marginTop: '4px' } }, 'Stored only on this device.')) : null),
      h('div', { class: 'panel' },
        h('h2', null, 'Rally'),
        h('div', { class: 'grid2' },
          num('carNumber', 'Car number', { int: true, min: 0 }),
          tod('baseStart', 'Car 0 starts at (start = this + car number minutes)'),
          num('defaultLimit', 'Default speed limit (mph)', { min: 0 })),
        h('label', null, 'Timing unit'),
        seg('timingUnit', [['s', 'Seconds'], ['cent', 'Hundredths of a minute']]),
        h('label', null, 'Largest time allowance per leg (from the GIs; Richta steps 0:10, 0:20, 0:30, 1:30 …)'),
        seg('taMax_s', [[570, '9:30'], [1170, '19:30']]),
        h('label', null, 'When Richta beeps at a control (the GIs say which)'),
        seg('legStyle', [['restart', 'Timing carries on from the restart'], ['control', 'Next leg starts from that time']]),
        h('div', { class: 'muted', style: { fontSize: '.9rem', marginTop: '4px' } }, 'Not sure? Keep "carries on". Tap Checkpoint beep on the Drive screen at each Richta beep either way. When the beep ends a segment (the next timed line is a restart), the app stops timing until you cross that restart, so each segment starts fresh.'),
        range('alpha', 'Smoothing alpha', 0, 1, 0.1)),
      h('div', { class: 'panel' },
        h('h2', null, 'Voice'),
        h('label', { class: 'sw', style: { color: 'var(--text)' } },
          h('input', { type: 'checkbox', checked: !!settings.voice, onchange: e => set('voice', e.target.checked) }), 'Speak prompts aloud'),
        range('voiceRate', 'Voice speed', 0.8, 1.4, 0.1),
        h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn-info', onclick: act('testVoice') }, 'Test voice'))),
      h('div', { class: 'panel' },
        h('h2', null, 'Sensors'),
        h('label', null, 'Source'),
        seg('sensorSource', [['auto', 'Auto'], ['racebox', 'RaceBox'], ['gps', 'Phone GPS'], ['obd', 'OBD']]),
        h('div', { class: 'row', style: { margin: '12px 0' } },
          h('button', { class: 'btn-info', onclick: act('connectRaceBox') }, 'Connect RaceBox'),
          h('button', { class: 'btn-info', onclick: act('connectObd') }, 'Connect OBD'),
          h('button', { onclick: act('testMark') }, 'Test mark')),
        line('RaceBox', status.racebox), line('OBD', status.obd), line('GPS', status.gps), line('Last key', status.lastKey)));
  }
  render();

  return {
    update(next) {
      if (next.settings) settings = { ...settings, ...next.settings };
      if (next.status) status = { ...status, ...next.status };
      // don't clobber a field the user is typing in
      if (root.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' && document.activeElement.type !== 'checkbox') {
        const lines = root.querySelectorAll('.row .muted.grow');
        const vals = [status.racebox, status.obd, status.gps, status.lastKey];
        lines.forEach((el, i) => { if (i < 4) el.textContent = vals[i] || '—'; });
        return;
      }
      render();
    },
    destroy() { root.remove(); },
  };
}
