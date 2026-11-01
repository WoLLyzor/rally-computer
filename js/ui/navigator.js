// Navigator workstation.
// mountNavigator(container, { instructions, table, unit, onAction }) -> { update, setRoute, setLog, destroy }
import { h, clear, fmtOm, actionSummary, actionIcon, explainEl, digestEls } from './dom.js';
import { glossaryOf } from '../core/extract.js';
import { deltaView, fmtCountdown } from './driver.js';

const p2 = (n) => String(n).padStart(2, '0');

export function fmtTod(s, unit) {
  if (s == null || Number.isNaN(s)) return '--:--:--';
  s = Math.max(0, s);
  const H = Math.floor(s / 3600) % 24, M = Math.floor((s % 3600) / 60), S = s % 60;
  if (unit === 'cent') {
    const cc = Math.min(99, Math.floor((S / 60) * 100 + 1e-9));
    return `${p2(H)}:${p2(M)}.${p2(cc)}`;
  }
  return `${p2(H)}:${p2(M)}:${p2(Math.floor(S))}`;
}

export function mountNavigator(container, { instructions = [], table = [], unit = 's', digest = null, onAction } = {}) {
  const act = (name, arg) => { try { onAction && onAction(name, arg); } catch (e) { console.error(e); } };
  let dg = digest, gloss = dg ? glossaryOf(dg) : null;
  let ins = instructions, tbl = table, live = null, curN = null, off = false, lastAlertKind = null;
  const rows = new Map();
  const U = () => (live && live.unit) || unit;

  // ---------- sheets ----------
  let sheetEl = null;
  function closeSheet() { if (sheetEl) { sheetEl.remove(); sheetEl = null; } }
  function openSheet(title, ...body) {
    closeSheet();
    sheetEl = h('div', { class: 'nv-overlay', onclick: (e) => { if (e.target === sheetEl) closeSheet(); } },
      h('div', { class: 'nv-sheet', role: 'dialog' },
        h('h2', { class: 'nv-sheet-title' }, title), ...body));
    root.appendChild(sheetEl);
    return sheetEl;
  }
  function confirmSheet(msg, okLabel, onOk) {
    openSheet(msg,
      h('div', { class: 'nv-sheet-btns' },
        h('button', { class: 'nv-bigbtn', onclick: closeSheet }, 'Cancel'),
        h('button', { class: 'nv-bigbtn nv-go', onclick: () => { closeSheet(); onOk(); } }, okLabel)));
  }
  function timeEditor(initial) {
    let v = Math.round(initial ?? 0);
    const disp = h('div', { class: 'nv-tdisp' }, fmtTod(v, U()));
    const set = (x) => { v = Math.max(0, x); disp.textContent = fmtTod(v, U()); };
    const nud = (label, d) => h('button', { class: 'nv-nudge', onclick: () => set(v + d) }, label);
    const el = h('div', { class: 'nv-teditor' }, disp,
      h('div', { class: 'nv-nudges' },
        nud('−1 min', -60), nud('−10 s', -10), nud('−1 s', -1),
        nud('+1 s', 1), nud('+10 s', 10), nud('+1 min', 60)),
      h('button', { class: 'nv-nudge nv-now', onclick: () => set(Math.round(live ? live.t_s : v)) }, 'Now'));
    return { el, get: () => v };
  }

  function checkpointSheet() {
    const from = live && live.next ? live.next.n : (ins[0] && ins[0].n);
    const ctl = ins.find((i) => i.n >= from && i.action === 'control') || ins.find((i) => i.n === from);
    const n = ctl ? ctl.n : from;
    let kind = 'in';
    const ed = timeEditor(live ? live.t_s : 0);
    const bIn = h('button', { 'aria-pressed': 'true', onclick: () => pick('in') }, 'IN');
    const bOut = h('button', { 'aria-pressed': 'false', onclick: () => pick('out') }, 'OUT');
    function pick(k) { kind = k; bIn.setAttribute('aria-pressed', String(k === 'in')); bOut.setAttribute('aria-pressed', String(k === 'out')); }
    openSheet(`Checkpoint #${n}${ctl ? ' · ' + actionSummary(ctl) : ''}`,
      h('div', { class: 'nv-seg' }, bIn, bOut), ed.el,
      h('div', { class: 'nv-sheet-btns' },
        h('button', { class: 'nv-bigbtn', onclick: closeSheet }, 'Cancel'),
        h('button', { class: 'nv-bigbtn nv-go', onclick: () => { const tod = ed.get(); closeSheet(); act('checkpoint', { n, kind, tod }); } }, 'Log')));
  }
  function taSheet() {
    const sug = live && live.ta_suggest;
    const opts = [[30, '½'], [60, '1'], [90, '1½'], [120, '2'], [150, '2½'], [180, '3']];
    openSheet('Time allowance',
      h('div', { class: 'nv-tasug' }, sug
        ? `Suggested: ${(sug.taS / 60).toFixed(1)} min (${sug.taS} s), leaves ${sug.residualS > 0 ? '+' : ''}${sug.residualS} s`
        : 'No suggestion available'),
      h('div', { class: 'nv-tagrid' }, opts.map(([s, l]) =>
        h('button', { class: 'nv-bigbtn' + (sug && sug.taS === s ? ' nv-go' : ''), onclick: () => { closeSheet(); act('ta', { s }); } }, l + ' min'))),
      h('div', { class: 'nv-sheet-btns' }, h('button', { class: 'nv-bigbtn', onclick: closeSheet }, 'Cancel')));
  }
  function restartSheet() {
    const ed = timeEditor(live ? live.t_s : 0);
    openSheet('Restart time', ed.el,
      h('div', { class: 'nv-sheet-btns' },
        h('button', { class: 'nv-bigbtn', onclick: closeSheet }, 'Cancel'),
        h('button', { class: 'nv-bigbtn nv-go', onclick: () => { const tod = ed.get(); closeSheet(); act('restart', { tod }); } }, 'Restart')));
  }
  function rulesSheet() {
    openSheet('Rules from the GIs', h('div', { class: 'nv-rules' }, dg ? digestEls(dg) : h('div', { class: 'muted' }, 'No general instructions were read.')),
      h('div', { class: 'nv-sheet-btns' }, h('button', { class: 'nv-bigbtn', onclick: closeSheet }, 'Close')));
  }
  function limitOtherSheet() {
    const inp = h('input', { type: 'number', inputmode: 'numeric', min: '5', max: '85', step: '5', value: String(live && live.limit_mph || 35) });
    openSheet('Speed limit (mph)', inp,
      h('div', { class: 'nv-sheet-btns' },
        h('button', { class: 'nv-bigbtn', onclick: closeSheet }, 'Cancel'),
        h('button', { class: 'nv-bigbtn nv-go', onclick: () => { const mph = Number(inp.value); if (mph > 0) { closeSheet(); act('limit', { mph }); } } }, 'Set')));
  }

  // ---------- layout ----------
  const E = {};
  E.alert = h('div', { class: 'nv-alert', hidden: true });
  E.list = h('div', { class: 'nv-list', role: 'list' });
  E.clock = h('div', { class: 'nv-clock' }, '--:--:--');
  E.dBig = h('span', { class: 'nv-dbig dv-white' }, '--');
  E.dWord = h('span', { class: 'nv-dword' }, '');
  E.transit = h('div', { class: 'nv-transit', hidden: true });
  E.next = h('div', { class: 'nv-next', hidden: true });
  let nextKey = '';
  E.stats = {};
  const stat = (k, label) => { E.stats[k] = h('b', {}, '--'); return h('div', { class: 'nv-stat' }, h('span', {}, label), E.stats[k]); };
  const statsRow = h('div', { class: 'nv-stats' }, stat('om', 'OM'), stat('speed', 'SPEED'), stat('cast', 'CAST'), stat('target', 'TARGET'), stat('limit', 'LIMIT'));

  const btn = (label, cls, fn) => h('button', { class: 'nv-bigbtn ' + (cls || ''), onclick: fn }, label);
  E.offBtn = btn('Off course', 'nv-watch', () => { off = !off; syncOff(); act('offcourse', { on: off }); });
  function syncOff() { E.offBtn.textContent = off ? 'Back on course' : 'Off course'; E.offBtn.classList.toggle('nv-on', off); }
  const limRow = h('div', { class: 'nv-limrow' },
    [25, 35, 45, 55].map((m) => btn(String(m), 'nv-lim', () => act('limit', { mph: m }))),
    btn('other', 'nv-lim', limitOtherSheet));
  const buttons = h('div', { class: 'nv-buttons' },
    btn('MARK', 'nv-mark', () => act('mark')),
    btn('Rules', 'nv-rules-btn', rulesSheet),
    limRow,
    h('div', { class: 'nv-btnrow' },
      btn('Checkpoint', '', checkpointSheet), btn('TA', '', taSheet), btn('Restart', '', restartSheet)),
    h('div', { class: 'nv-btnrow' },
      btn('End odo check', '', () => confirmSheet('End odometer check?', 'End check', () => act('odo_end'))),
      E.offBtn, btn('Undo last', '', () => act('undo'))));

  E.dots = {};
  const dot = (k, label) => { E.dots[k] = h('i', { class: 'nv-dot' }); return h('span', { class: 'nv-h' }, E.dots[k], label); };
  E.k = h('span', {}, 'k --'); E.resync = h('span', { class: 'nv-resync' }, '');
  const status = h('div', { class: 'nv-status' }, dot('racebox', 'RaceBox'), dot('obd', 'OBD'), dot('gps', 'GPS'), E.k, E.resync);

  E.logBody = h('div', { class: 'nv-logbody' });
  const logPanel = h('details', { class: 'nv-log', open: true }, h('summary', {}, 'Log'), E.logBody);

  const right = h('div', { class: 'nv-right' },
    h('div', { class: 'nv-top' }, E.clock, h('div', { class: 'nv-delta' }, E.dBig, E.dWord)),
    E.transit, E.next, statsRow, buttons, status, logPanel);
  const root = h('div', { class: 'nv-root' }, E.alert, h('div', { class: 'nv-cols' }, E.list, right));
  container.appendChild(root);

  // ---------- list ----------
  function buildRows() {
    clear(E.list); rows.clear();
    const byN = new Map(tbl.map((t) => [t.n, t]));
    for (const i of ins) {
      const t = byN.get(i.n);
      const row = h('div', { class: 'nv-row', role: 'listitem', dataset: { n: i.n },
        onclick: () => confirmSheet(`Make #${i.n} the next instruction?`, 'Make next', () => act('jump', { n: i.n })) },
        h('span', { class: 'nv-n' }, i.n),
        h('span', { class: 'nv-om' }, fmtOm(i.om)),
        h('span', { class: 'nv-ico' }, actionIcon(i)),
        h('span', { class: 'nv-sum' }, h('span', { class: 'nv-printed' }, i.text || ''), explainEl(i, { glossary: gloss, warn: false, terms: false, size: 'sm' })),
        h('span', { class: 'nv-pt' }, t && t.T_arrive != null ? fmtTod(t.T_arrive, U()) : ''));
      rows.set(i.n, row); E.list.appendChild(row);
    }
    curN = null; markCurrent(live && live.next ? live.next.n : null);
  }
  function markCurrent(n) {
    if (n === curN) return;
    curN = n;
    for (const [k, row] of rows) {
      row.classList.toggle('nv-cur', k === n);
      row.classList.toggle('nv-past', n != null && k < n);
    }
    const r = rows.get(n);
    if (r) r.scrollIntoView({ block: 'center' });
  }

  function update(l) {
    if (!l) return;
    live = l;
    E.alert.hidden = !l.alert;
    if (l.alert) E.alert.textContent = l.alert.text || l.alert.kind;
    const ak = l.alert ? l.alert.kind : null;
    if (ak !== lastAlertKind) {
      lastAlertKind = ak;
      if (ak === 'offcourse' && !off) { off = true; syncOff(); }
    }
    E.clock.textContent = fmtTod(l.t_s, U());
    if (l.hold) { E.dBig.className = 'nv-dbig ' + (l.hold.go ? 'dv-good' : 'dv-info'); E.dBig.textContent = l.hold.go ? 'GO' : String(Math.max(0, Math.ceil(l.hold.in_s))); E.dWord.textContent = l.hold.go ? 'PAUSE DONE' : 'PAUSE · GO IN'; }
    else if (l.delta_s == null) { E.dBig.className = 'nv-dbig dv-muted'; E.dBig.textContent = '--'; E.dWord.textContent = ''; }
    else { const v = deltaView(l.delta_s, U()); E.dBig.className = 'nv-dbig ' + v.cls; E.dBig.textContent = v.big; E.dWord.textContent = v.word; }
    const tr = l.zone === 'transit' && l.transit;
    E.transit.hidden = !tr;
    if (tr) E.transit.textContent = `TRANSIT · arrive ${fmtTod(tr.arrive_tod, U())} · in ${fmtCountdown(tr.remaining_s)}`;
    const f = (v) => (v == null ? '--' : Math.round(v));
    E.stats.om.textContent = l.d_om == null || !l.started ? '--' : l.d_om.toFixed(2);
    E.stats.speed.textContent = l.speed_mph == null ? '--' : l.speed_mph.toFixed(1);
    E.stats.cast.textContent = f(l.cast_mph);
    E.stats.target.textContent = f(l.target_mph);
    E.stats.limit.textContent = l.limit_mph == null ? '?' : Math.round(l.limit_mph) + (l.limit_src === 'default' ? '*' : '');
    const hh = l.health || {};
    for (const k of ['racebox', 'obd', 'gps']) E.dots[k].className = 'nv-dot nv-' + (hh[k] || 'off');
    E.k.textContent = 'k ' + (hh.k != null ? hh.k.toFixed(4) : '--');
    E.resync.textContent = hh.last_resync ? 'resync ' + hh.last_resync : '';
    markCurrent(l.next ? l.next.n : null);
    const nx = l.next, key = nx ? nx.n + '|' + nx.text : '';
    if (key !== nextKey) {
      nextKey = key; clear(E.next);
      E.next.hidden = !nx;
      if (nx) E.next.append(h('b', { class: 'nv-next-n' }, 'Next #' + nx.n),
        nx.ins ? explainEl(nx.ins, { glossary: gloss }) : h('div', null, nx.text || ''));
    }
  }
  function setRoute(i, t, d) { ins = i || []; tbl = t || []; if (d !== undefined) { dg = d || null; gloss = dg ? glossaryOf(dg) : null; } buildRows(); }
  function setLog(entries) {
    clear(E.logBody);
    for (const e of (entries || []).slice(0, 100)) E.logBody.appendChild(
      h('div', { class: 'nv-logrow' }, h('span', {}, fmtTod(e.t_s, U())), ' ', e.text));
  }
  function destroy() { root.remove(); }

  buildRows(); syncOff();
  return { update, setRoute, setLog, destroy };
}
