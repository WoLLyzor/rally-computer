// Navigator workstation. Simple mode (the default): a coach line saying what to do now, the list, and six
// big labelled buttons; the rest under MORE. Full mode: every control at once.
// mountNavigator(container, { instructions, table, unit, onAction, mode, startTod, moreItems })
//   -> { update, setRoute, setLog, toast, setMode, destroy }
import { h, clear, fmtOm, actionSummary, actionIcon, explainEl, digestEls } from './dom.js';
import { glossaryOf } from '../core/extract.js';
import { richtaLadder, taPresses } from '../core/timing.js';
import { deltaView, fmtCountdown } from './driver.js';
import { coach } from '../app/coach.js';

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

export function mountNavigator(container, { instructions = [], table = [], unit = 's', digest = null, onAction, mode = 'simple', startTod = null, moreItems = [] } = {}) {
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
  // After a pause the distance is in doubt: tapping the instruction the car is at fixes it.
  function hereSheet(i) {
    openSheet(`Are you at #${i.n} now?`,
      h('p', { class: 'nv-sheet-note' }, `Tap "We're here" as you pass its point: the distance becomes ${fmtOm(i.om)}.`),
      h('div', { class: 'nv-sheet-btns' },
        h('button', { class: 'nv-bigbtn', onclick: closeSheet }, 'Cancel'),
        h('button', { class: 'nv-bigbtn', onclick: () => { closeSheet(); act('jump', { n: i.n }); } }, 'Make next'),
        h('button', { class: 'nv-bigbtn nv-go', onclick: () => { closeSheet(); act('here', { n: i.n }); } }, "We're here")));
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
  // Time allowance as Richta keeps it: one running total per leg on its fixed steps. The crew picks the
  // total Richta should show; the app says which button to press there and how many times.
  const ms = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  function taSheet() {
    const sug = live && live.ta_suggest, cur = (live && live.ta_leg_s) || 0;
    const ladder = richtaLadder((live && live.ta_max_s) || 1170);
    const press = (to) => { const k = taPresses(cur, to, ladder); return k == null ? '' : k > 0 ? `Richta TA+ ×${k}` : `Richta TA− ×${-k}`; };
    const above = ladder.filter((x) => x > cur);
    const shown = above.slice(0, Math.max(9, sug ? above.indexOf(sug.totalS) + 3 : 0));
    const below = [0, ...ladder].filter((x) => x < cur);
    const pick = (x, go) => h('button', { class: 'nv-bigbtn nv-tabtn' + (go ? ' nv-go' : ''), onclick: () => { closeSheet(); act('ta', { total: x }); } },
      h('b', {}, ms(x)), h('small', {}, press(x)));
    const after = !sug ? '' : sug.residualS < -1 ? ` Then lose ${Math.round(-sug.residualS)} s: ease off, or wait safely off the road.` : sug.residualS > 1 ? ` Then make up ${Math.round(sug.residualS)} s.` : '';
    openSheet(`Delay: add time (Richta calls it TA)${cur ? ` · so far ${ms(cur)}` : ''}`,
      h('p', { class: 'nv-sheet-note' }, 'Held up by something you couldn’t help (train, tractor, school bus, traffic)? Tap the green total, then press TA+ in Richta the number of times shown. Do it now: checkpoints are hidden, and time added after one is too late.'),
      h('div', { class: 'nv-tasug' }, sug ? `Suggested: ${ms(sug.totalS)} total: in Richta, ${press(sug.totalS).replace('Richta ', '')}.${after}` : 'You aren’t late enough to need this right now.'),
      h('div', { class: 'nv-tagrid' }, shown.map((x) => pick(x, sug && sug.totalS === x))),
      below.length ? h('details', { class: 'nv-tadown' }, h('summary', {}, 'Took too much? Lower it'), h('div', { class: 'nv-tagrid' }, below.map((x) => pick(x, false)))) : null,
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
  // Every control fits on screen at once: MARK, the limits, then one grid, most used first.
  const buttons = h('div', { class: 'nv-buttons' },
    btn('MARK', 'nv-mark', () => act('mark')),
    limRow,
    h('div', { class: 'nv-actions' },
      btn('RICHTA BEEPED', 'nv-go', () => act('richta', { via: 'tap' })), E.taBtn = btn('TA', '', taSheet), btn('Undo last', '', () => act('undo')),
      btn('Staffed control', '', checkpointSheet), btn('Restart time', '', restartSheet), E.offBtn,
      btn('End odo check', '', () => confirmSheet('End odometer check?', 'End check', () => act('odo_end'))),
      btn('Rules', 'nv-rules-btn', rulesSheet), btn('More', '', () => moreSheet())));

  E.dots = {};
  const dot = (k, label) => { E.dots[k] = h('i', { class: 'nv-dot' }); return h('span', { class: 'nv-h' }, E.dots[k], label); };
  E.k = h('span', {}, 'k --'); E.resync = h('span', { class: 'nv-resync' }, '');
  const status = h('div', { class: 'nv-status' }, dot('racebox', 'RaceBox'), dot('obd', 'OBD'), dot('gps', 'GPS'), E.k, E.resync);

  E.logBody = h('div', { class: 'nv-logbody' });
  const logPanel = h('details', { class: 'nv-log' }, h('summary', {}, 'Log'), E.logBody);

  // Simple mode: six big buttons, each saying what it's for. The fourth slot is START before the start and
  // BACK ON ROUTE after a missed turn or when off course; it keeps its place (empty) otherwise.
  const big = (label, sub, cls, fn) => h('button', { class: `nv-sbtn ${cls}`, onclick: fn }, h('b', {}, label), h('small', {}, sub));
  E.richtaBtn = big('RICHTA BEEPED', 'tap each time Richta beeps', 'nv-s-richta', () => act('richta', { via: 'tap' }));
  E.markBtn = big('MARK', 'as you pass a sign or landmark', 'nv-s-mark', () => act('mark'));
  E.delayBtn = big('DELAY', 'held up? add time', 'nv-s-delay', taSheet);
  E.ctxBtn = big('START', 'as you leave the start line', 'nv-s-ctx', () => ctxRun());
  E.undoBtn = big('UNDO', 'take back the last tap', 'nv-s-undo', () => act('undo'));
  E.moreBtn = big('MORE', 'other tools and help', 'nv-s-more', moreSheet);
  const simpleBox = h('div', { class: 'nv-simple' }, E.richtaBtn, h('div', { class: 'nv-srow' }, E.markBtn, E.delayBtn), E.ctxBtn, h('div', { class: 'nv-srow' }, E.undoBtn, E.moreBtn));
  function ctxRun() {
    if (!live || !live.started) act('start');
    else if (live.alert && live.alert.kind === 'missed_turn') act('here', { n: live.alert.n });
    else if (live.alert && live.alert.kind === 'offcourse') { off = false; syncOff(); act('offcourse', { on: false }); }
    else if (live.map_hint && live.map_hint.kind === 'offroute') act('rejoin', {});
  }
  E.coachTitle = h('div', { class: 'nv-coach-title' }, '');
  E.coachText = h('div', { class: 'nv-coach-text' }, '');
  E.coach = h('div', { class: 'nv-coach', role: 'status', 'aria-live': 'polite' }, E.coachTitle, E.coachText);
  E.toast = h('div', { class: 'nv-toast', hidden: true });

  const right = h('div', { class: 'nv-right' },
    h('div', { class: 'nv-top' }, E.clock, h('div', { class: 'nv-delta' }, E.dBig, E.dWord)),
    E.transit, E.next, statsRow, simpleBox, buttons, status, logPanel);
  const root = h('div', { class: `nv-root nv-mode-${mode}` }, E.alert, E.coach, E.toast, h('div', { class: 'nv-cols' }, E.list, right));
  container.appendChild(root);

  // MORE: the tools needed now and then, each with one line on when to use it.
  function moreSheet() {
    const item = (label, note, fn, cls = '') => h('div', { class: 'nv-more-item' },
      h('button', { class: `nv-bigbtn ${cls}`, onclick: () => { closeSheet(); fn(); } }, label), h('div', { class: 'nv-more-note' }, note));
    openSheet('More tools',
      h('div', { class: 'nv-more-lim' }, h('div', { class: 'nv-more-note' }, 'Speed limit sign (optional): the app never asks for more than this.'),
        h('div', { class: 'nv-limrow' }, [25, 35, 45, 55].map((m) => h('button', { class: 'nv-bigbtn nv-lim', onclick: () => { closeSheet(); act('limit', { mph: m }); } }, String(m))),
          h('button', { class: 'nv-bigbtn nv-lim', onclick: limitOtherSheet }, 'other'))),
      h('div', { class: 'nv-more-grid' },
        item('End odo check', 'Once, at the end of the odometer check, if MARK didn’t catch it.', () => confirmSheet('End odometer check?', 'End check', () => act('odo_end'))),
        item(off ? 'Back on course' : 'Off course', 'You took a wrong road: tap now, then again when you’re back where you left the route.', () => { off = !off; syncOff(); act('offcourse', { on: off }); }),
        item('Restart time', 'Fix a restart time that doesn’t match Richta’s.', restartSheet),
        item('Staffed control', 'Only if a person at a control gives you an out time.', checkpointSheet),
        item('Rules', 'The rules read from the general instructions.', rulesSheet),
        ...moreItems.map((m) => item(m.label, m.note, m.run))),
      h('div', { class: 'nv-sheet-btns' }, h('button', { class: 'nv-bigbtn', onclick: closeSheet }, 'Close')));
  }

  let toastTimer = null;
  function toast(text) {
    if (!text) return;
    E.toast.textContent = text; E.toast.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { E.toast.hidden = true; }, 6000);
  }
  function setMode(m) { root.classList.remove('nv-mode-simple', 'nv-mode-full'); root.classList.add(`nv-mode-${m}`); }

  // ---------- list ----------
  function buildRows() {
    clear(E.list); rows.clear();
    const byN = new Map(tbl.map((t) => [t.n, t]));
    for (const i of ins) {
      const t = byN.get(i.n);
      const row = h('div', { class: 'nv-row', role: 'listitem', dataset: { n: i.n },
        onclick: () => (live && live.recovering && i.D != null ? hereSheet(i) : confirmSheet(`Make #${i.n} the next instruction?`, 'Make next', () => act('jump', { n: i.n }))) },
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
    E.taBtn.textContent = l.ta_leg_s ? `TA ${ms(l.ta_leg_s)}` : 'TA';
    if (l.hold) { E.dBig.className = 'nv-dbig ' + (l.hold.go ? 'dv-good' : 'dv-info'); E.dBig.textContent = l.hold.go ? 'GO' : String(Math.max(0, Math.ceil(l.hold.in_s))); E.dWord.textContent = l.hold.go ? 'PAUSE DONE' : 'PAUSE · GO IN'; }
    else if (l.waiting) { const w = l.waiting, timed = w.in_s !== null && w.in_s !== undefined; E.dBig.className = 'nv-dbig ' + (timed ? 'dv-info' : 'dv-muted'); E.dBig.textContent = timed ? (w.in_s > 0 ? fmtCountdown(w.in_s) : 'GO') : '--'; E.dWord.textContent = timed ? `RESTART #${w.n}` : 'SEGMENT DONE'; }
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
    E.stats.limit.textContent = l.limit_mph == null ? '–' : Math.round(l.limit_mph) + (l.limit_src === 'default' ? '*' : '');
    const hh = l.health || {};
    for (const k of ['racebox', 'obd', 'gps']) E.dots[k].className = 'nv-dot nv-' + (hh[k] || 'off');
    E.k.textContent = 'k ' + (hh.k != null ? hh.k.toFixed(4) : '--');
    E.resync.textContent = hh.last_resync ? 'resync ' + hh.last_resync : '';
    markCurrent(l.next ? l.next.n : null);
    // The coach line, and the button it points at.
    const c = coach(l, { rows: ins, startTod });
    if (E.coachTitle.textContent !== c.title) E.coachTitle.textContent = c.title;
    if (E.coachText.textContent !== c.text) E.coachText.textContent = c.text;
    E.coach.className = `nv-coach nv-tone-${c.tone}`;
    const ctx = !l.started ? ['START', 'as you leave the start line'] : (l.alert && (l.alert.kind === 'missed_turn' || l.alert.kind === 'offcourse')) || (l.map_hint && l.map_hint.kind === 'offroute') ? ['BACK ON ROUTE', 'tap as you rejoin the route'] : null;
    E.ctxBtn.style.visibility = ctx ? '' : 'hidden';
    if (ctx && E.ctxBtn.firstChild.textContent !== ctx[0]) { E.ctxBtn.firstChild.textContent = ctx[0]; E.ctxBtn.lastChild.textContent = ctx[1]; }
    E.richtaBtn.classList.toggle('nv-hint', c.act === 'richta');
    E.markBtn.classList.toggle('nv-hint', c.act === 'mark');
    E.ctxBtn.classList.toggle('nv-hint', !!ctx && (c.act === 'start' || c.act === 'back'));
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
  return { update, setRoute, setLog, toast, setMode, destroy };
}
