// Driver glance display. mountDriver(container, { unit }) -> { update(live), destroy() }
import { h, clear, fmtOm, actionSummary, actionIcon, explainEl } from './dom.js';

export function fmtCountdown(s) {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Returns { big, word, cls } for a delta in seconds.
export function deltaView(delta_s, unit) {
  const a = Math.abs(delta_s);
  const big = unit === 'cent' ? Math.round(a / 0.6) : Math.round(a);
  let word = delta_s > 0 ? 'LATE' : 'EARLY';
  if (Math.round(a * 10) === 0 || big === 0) word = 'ON TIME';
  const cls = a <= 1 ? 'dv-good' : a <= 3 ? 'dv-watch' : 'dv-white';
  return { big: String(big), word, cls };
}

export function mountDriver(container, { unit = 's' } = {}) {
  const el = {};
  el.alert = h('div', { class: 'dv-alert', hidden: true });
  el.chip = h('div', { class: 'dv-chip', hidden: true }, 'FREE ZONE');
  el.big = h('div', { class: 'dv-big dv-white' }, '--');
  el.word = h('div', { class: 'dv-word' }, '');
  el.delta = h('div', { class: 'dv-delta' }, el.big, el.word);
  el.target = h('div', { class: 'dv-target' }, '--');
  el.avg = h('div', { class: 'dv-limit' }, '');   // your actual average since the timed zone started
  el.speed = h('div', { class: 'dv-speed' },
    el.target, h('div', { class: 'dv-mph' }, 'mph'), el.avg);
  el.icon = h('div', { class: 'dv-icon' }, '');
  el.dist = h('div', { class: 'dv-dist' }, '');
  el.text = h('div', { class: 'dv-text' }, '');
  el.next = h('div', { class: 'dv-next' }, el.icon,
    h('div', { class: 'dv-nextbody' }, el.dist, el.text));
  const root = h('div', { class: 'dv-root' }, el.alert, el.chip, el.delta,
    h('div', { class: 'dv-bottom' }, el.speed, el.next));
  container.appendChild(root);

  let last = '';
  function update(live) {
    if (!live) return;
    const a = live.alert;
    el.alert.hidden = !a;
    if (a) el.alert.textContent = a.text || a.kind;

    const transit = live.zone === 'transit';
    el.chip.hidden = live.zone !== 'free';
    root.classList.toggle('dv-transit', !!transit);
    if (live.hold) {
      el.big.className = 'dv-big dv-small ' + (live.hold.go ? 'dv-good' : 'dv-info');
      el.big.textContent = live.hold.go ? 'GO' : fmtCountdown(live.hold.in_s);
      el.word.textContent = live.hold.go ? `PAUSE #${live.hold.n} DONE` : `PAUSE #${live.hold.n} · GO IN`;
    } else if (transit) {
      // Only the timed zones count: no clock to race in a transit.
      el.big.className = 'dv-big dv-muted dv-small';
      el.big.textContent = 'TRANSIT';
      el.word.textContent = 'NO TIMING';
    } else if (live.waiting) {
      // Segment done: no timing until the restart (a countdown when its time is printed).
      const w = live.waiting, timed = w.in_s !== null && w.in_s !== undefined;
      el.big.className = 'dv-big dv-small ' + (timed ? (w.in_s > 0 ? 'dv-info' : 'dv-good') : 'dv-muted');
      el.big.textContent = timed ? (w.in_s > 0 ? fmtCountdown(w.in_s) : 'GO') : '--';
      el.word.textContent = timed ? `RESTART #${w.n} ${w.in_s > 0 ? 'IN' : 'NOW'}` : `SEGMENT DONE · RESTART #${w.n}`;
    } else if (live.delta_s == null) {
      el.big.className = 'dv-big dv-muted';
      el.big.textContent = '--';
      el.word.textContent = '';
    } else {
      const v = deltaView(live.delta_s, live.unit || unit);
      el.big.className = 'dv-big ' + v.cls;
      el.big.textContent = v.big;
      el.word.textContent = v.word;
    }

    el.target.textContent = live.target_mph != null ? Math.round(live.target_mph) : '--';
    el.avg.textContent = live.avg_mph != null ? `avg ${live.avg_mph.toFixed(1)}${live.cast_mph ? ` · CAST ${live.cast_mph}` : ''}` : '';

    const nx = live.next;
    if (nx) {
      const ins = nx.ins || {};
      const key = nx.n + '|' + nx.text;
      if (key !== last) {
        last = key;
        el.icon.textContent = nx.ins ? actionIcon(ins) : '•';
        clear(el.text);
        if (nx.ins) el.text.appendChild(explainEl(nx.ins, { warn: false, terms: false }));
        else el.text.textContent = nx.text || '';
        el.next.classList.remove('dv-fade'); void el.next.offsetWidth; el.next.classList.add('dv-fade');
      }
      el.dist.textContent = nx.to_mi != null ? `${fmtOm(nx.to_mi)} mi`
        : (nx.om != null ? `OM ${fmtOm(nx.om)}` : '');
    } else {
      last = '';
      el.icon.textContent = '';
      el.dist.textContent = '';
      clear(el.text);
      el.text.textContent = 'No further instructions';
    }
  }
  function destroy() { root.remove(); }
  return { update, destroy };
}
