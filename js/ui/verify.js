// Driver verify screen: check every instruction row against the photo crop.
import { h, clear, fmtOm, actionSummary, actionIcon, explainEl, digestEls } from './dom.js';
import { glossaryOf } from '../core/extract.js';

const CONF_MIN = 0.9;
const DIRS = ['L', 'R', 'S', 'BL', 'BR'];
const CUES = ['T', 'Y', 'stop', 'yield', 'signal', 'sign', 'om', 'landmark'];

export function mountVerify(container, opts) {
  const { pages = [], onEdit = () => {}, onVerify = () => {}, onDone = () => {} } = opts;
  let instructions = opts.instructions || [];
  let flags = opts.flags || [];
  let digest = opts.digest || null;
  let glossary = digest ? glossaryOf(digest) : null;
  let rulesOpen = true;
  const legsIn = opts.legs || [];
  let curLeg = 0;
  let bannerOpen = false;
  const started_ms = Date.now();
  const perRow = new Map(); // n -> ms since previous verify
  let lastMark = started_ms;
  const imgCache = new Map();
  let sheet = null;
  let destroyed = false;

  const root = h('div', { class: 'screen verify' });
  container.appendChild(root);
  const timerEl = h('span', { class: 'num' });
  const tick = setInterval(updateTimer, 1000);

  function getLegs() {
    if (legsIn.length) return legsIn;
    const ns = instructions.map(i => i.n);
    return [{ leg: 1, from_n: Math.min(...ns, 1), to_n: Math.max(...ns, 1), label: 'All' }];
  }
  const legRows = leg => instructions.filter(i => i.n >= leg.from_n && i.n <= leg.to_n);
  const rowFlags = n => flags.filter(f => f.n === n);
  const needsReview = i => (i.review && i.review.length) || rowFlags(i.n).length || (i.confidence != null && i.confidence < CONF_MIN);

  function queue(leg) {
    const rows = legRows(leg).sort((a, b) => a.n - b.n);
    const first = rows.filter(needsReview);
    const rest = rows.filter(r => !needsReview(r));
    return { first, rest, all: first.concat(rest) };
  }

  function updateTimer() {
    const s = Math.floor((Date.now() - started_ms) / 1000);
    timerEl.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function loadPage(pg) {
    if (!pg) return Promise.resolve(null);
    if (!imgCache.has(pg.page)) {
      imgCache.set(pg.page, new Promise(res => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => res(null);
        im.src = pg.url;
      }));
    }
    return imgCache.get(pg.page);
  }

  function cropView(ins) {
    const src = ins.src;
    const pg = src && pages.find(p => p.page === src.page);
    const box = h('div', { class: 'crop' });
    if (!pg) { box.appendChild(h('div', { class: 'muted', style: { padding: '12px' } }, 'No photo for this row')); return box; }
    if (src.bbox) {
      const cv = h('canvas');
      box.appendChild(cv);
      loadPage(pg).then(im => {
        if (!im || destroyed) return;
        const [bx, by, bw, bh] = src.bbox;
        const W = im.naturalWidth, H = im.naturalHeight;
        const m = bh * 0.25;
        const y0 = Math.max(0, by - m), y1 = Math.min(1, by + bh + m);
        const sx = Math.max(0, bx) * W, sy = y0 * H;
        const sw = Math.min(1 - Math.max(0, bx), bw) * W, sh = (y1 - y0) * H;
        const scale = Math.min(1, 1000 / sw);
        cv.width = Math.max(1, Math.round(sw * scale));
        cv.height = Math.max(1, Math.round(sh * scale));
        const g = cv.getContext('2d');
        g.drawImage(im, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
        // outline the row itself
        g.strokeStyle = '#f5b942'; g.lineWidth = 3;
        g.strokeRect(0, (by - y0) * H * scale, cv.width, bh * H * scale);
      });
    } else {
      box.appendChild(h('img', { src: pg.url, alt: `Page ${pg.page}`, style: { width: '100%' } }));
    }
    return box;
  }

  function emph(text) { return h('span', { class: 'hl' }, text); }

  function summaryEl(ins) {
    // Emphasise numbers (CAST/PAUSE/GAIN values) in the summary string.
    const s = actionSummary(ins);
    const out = [];
    const re = /(CAST \S+|PAUSE [\d.]+ s(?: \([\d.]+ min\))?|GAIN [\d.]+ s|\/0\.00)/g;
    let last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) out.push(s.slice(last, m.index));
      out.push(emph(m[0]));
      last = m.index + m[0].length;
    }
    out.push(s.slice(last));
    return h('div', { class: 'summary' }, h('span', { class: 'icon', style: { marginRight: '10px' } }, actionIcon(ins)), out);
  }

  function rowCard(ins) {
    const fl = rowFlags(ins.n);
    const needs = needsReview(ins);
    const card = h('div', { class: 'card' + (ins.verified ? ' verified' : needs ? ' needs' : ''), dataset: { n: ins.n } },
      h('div', { class: 'card-head' },
        h('div', { class: 'big-n' }, `#${ins.n}`),
        h('div', { class: 'big-om' }, fmtOm(ins.om, ins.om_decimals)),
        ins.verified ? h('span', { class: 'badge good' }, '✔ verified') : null,
        ins.confidence != null && ins.confidence < CONF_MIN ? h('span', { class: 'badge watch' }, `confidence ${Math.round(ins.confidence * 100)}%`) : null),
      summaryEl(ins),
      explainEl(ins, { glossary }),
      cropView(ins),
      h('div', { class: 'raw' }, ins.text || ''),
      (ins.review || []).map(r => h('div', { class: 'review' }, `${r.field}: Pass A ${r.a} | Pass B ${r.b}`)),
      fl.map(flagEl),
      h('div', { class: 'row', style: { marginTop: '12px' } },
        ins.verified
          ? [h('span', { class: 'good', style: { fontSize: '2rem' } }, '✔'),
             h('button', { onclick: () => { perRow.delete(ins.n); onVerify(ins.n, false); }, 'aria-label': `Undo verify ${ins.n}` }, 'Undo')]
          : h('button', { class: 'btn-primary grow', onclick: () => doVerify(ins.n), 'aria-label': `Verify instruction ${ins.n}` }, '✔ Correct'),
        h('button', { onclick: () => openEdit(ins) }, 'Edit')));
    return card;
  }

  function flagEl(f) {
    const sev = f.severity === 'danger' ? 'danger' : f.severity === 'watch' ? 'watch' : '';
    return h('div', { class: 'flag ' + sev }, h('b', null, f.kind || ''), f.message || '');
  }

  function doVerify(n) {
    const now = Date.now();
    perRow.set(n, now - lastMark);
    lastMark = now;
    const leg = getLegs()[curLeg];
    const q = queue(leg).all;
    const idx = q.findIndex(r => r.n === n);
    const next = q.slice(idx + 1).concat(q.slice(0, idx)).find(r => !r.verified && r.n !== n);
    onVerify(n, true);
    if (next) {
      // wait for the lead to push an update, then scroll; also try right away
      setTimeout(() => scrollToN(next.n), 80);
    }
  }
  function scrollToN(n) {
    const el = root.querySelector(`.card[data-n="${n}"]`);
    if (el) el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }

  // ---------- edit sheet ----------
  function openEdit(ins) {
    closeSheet();
    const vals = {
      om: ins.om, cast_mph: ins.cast_mph, pause_s: ins.pause_s, gain_s: ins.gain_s,
      dir: ins.dir, cue: ins.cue, onto: ins.onto, sign_text: ins.sign_text, text: ins.text,
    };
    const cur = { ...vals };
    const numField = (key, label) => {
      const inp = h('input', { type: 'text', inputmode: 'decimal', value: vals[key] == null ? '' : String(vals[key]), 'aria-label': label });
      inp.addEventListener('input', () => { cur[key] = inp.value.trim() === '' ? null : Number(inp.value); });
      return h('div', null, h('label', null, label), inp);
    };
    const txtField = (key, label) => {
      const inp = h('input', { type: 'text', value: vals[key] || '', 'aria-label': label });
      inp.addEventListener('input', () => { cur[key] = inp.value === '' ? null : inp.value; });
      return h('div', null, h('label', null, label), inp);
    };
    const segField = (key, label, opts2) => {
      const wrap = h('div', { class: 'seg' });
      const draw = () => {
        clear(wrap);
        [null, ...opts2].forEach(o => wrap.appendChild(h('button', {
          'aria-pressed': String(cur[key] === o), onclick: () => { cur[key] = o; draw(); },
        }, o == null ? 'none' : o)));
      };
      draw();
      return h('div', null, h('label', null, label), wrap);
    };
    const ta = h('textarea', { class: 'mono', value: vals.text || '', 'aria-label': 'Instruction text' });
    ta.addEventListener('input', () => { cur.text = ta.value; });

    const save = () => {
      const patch = {};
      for (const k of Object.keys(vals)) {
        if (typeof cur[k] === 'number' && Number.isNaN(cur[k])) continue;
        if (cur[k] !== vals[k]) patch[k] = cur[k];
      }
      closeSheet();
      if (Object.keys(patch).length) onEdit(ins.n, patch);
    };
    sheet = h('div', { class: 'sheet-back', onclick: e => { if (e.target === sheet) closeSheet(); } },
      h('div', { class: 'sheet', role: 'dialog', 'aria-label': `Edit instruction ${ins.n}` },
        h('h2', null, `Edit #${ins.n}`),
        h('div', { class: 'grid2' },
          numField('om', 'OM'), numField('cast_mph', 'CAST (mph)'),
          numField('pause_s', 'Pause (s)'), numField('gain_s', 'Gain (s)')),
        h('label', null, 'Direction'), segField('dir', '', DIRS).lastChild,
        h('label', null, 'Cue'), segField('cue', '', CUES).lastChild,
        h('div', { class: 'grid2' }, txtField('onto', 'Onto (road name)'), txtField('sign_text', 'Sign text')),
        h('label', null, 'Instruction text'), ta,
        h('div', { class: 'row', style: { marginTop: '10px' } },
          h('button', { class: 'btn-info', onclick: () => { const t = ta.value; closeSheet(); onEdit(ins.n, { text: t }); } }, 'Re-parse this line')),
        h('div', { class: 'row', style: { marginTop: '14px' } },
          h('button', { onclick: closeSheet }, 'Cancel'),
          h('button', { class: 'btn-primary grow', onclick: save }, 'Save'))));
    document.body.appendChild(sheet);
  }
  function closeSheet() { if (sheet) { sheet.remove(); sheet = null; } }

  // ---------- main render ----------
  function render() {
    const legs = getLegs();
    if (curLeg >= legs.length) curLeg = 0;
    const leg = legs[curLeg];
    const q = queue(leg);
    const total = instructions.length, ver = instructions.filter(i => i.verified).length;
    const toReview = instructions.filter(i => !i.verified && needsReview(i)).length;
    const globals = flags.filter(f => f.n == null);

    clear(root);
    root.append(...[
      h('div', { class: 'panel' },
        h('div', { class: 'row' },
          h('h1', { class: 'grow' }, 'Check every line'),
          h('span', { class: 'muted' }, 'Time '), timerEl,
          h('button', { class: 'btn-primary', onclick: () => onDone() }, 'Done')),
        h('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': ver, 'aria-valuemax': total }, h('i', { style: { width: (total ? ver / total * 100 : 0) + '%' } })),
        h('div', { class: 'row', style: { marginTop: '8px' } },
          h('span', null, `${ver}/${total} verified`),
          toReview ? h('span', { class: 'badge watch' }, `${toReview} to review first`) : h('span', { class: 'badge good' }, 'nothing left to review first'))),
      digest ? h('details', { class: 'panel rules-panel', open: rulesOpen, ontoggle: e => { if (e.target.classList.contains('rules-panel')) rulesOpen = e.target.open; } },
        h('summary', { class: 'info' }, 'Rules from the GIs'), digestEls(digest)) : null,
      globals.length ? h('details', { class: 'panel banner', open: bannerOpen, ontoggle: e => { bannerOpen = e.target.open; } },
        h('summary', { class: 'watch' }, `${globals.length} general note${globals.length > 1 ? 's' : ''}`),
        globals.map(flagEl)) : null,
      h('div', { class: 'tabs', role: 'tablist' }, legs.map((l, i) => {
        const rows = legRows(l), v = rows.filter(r => r.verified).length;
        return h('button', { role: 'tab', 'aria-selected': String(i === curLeg), class: v === rows.length && rows.length ? 'done' : '', onclick: () => { curLeg = i; render(); window.scrollTo(0, 0); } },
          h('span', null, l.label || `Leg ${l.leg}`), h('span', { class: 'cnt' }, `${v}/${rows.length}`));
      })),
      q.first.length ? h('div', { class: 'sec-title' }, `Review first (${q.first.length})`) : null,
      q.first.map(rowCard),
      q.first.length && q.rest.length ? h('div', { class: 'sec-title muted' }, 'Everything else') : null,
      q.rest.map(rowCard)].flat().filter(Boolean));   // Element.append prints null and arrays as text
    updateTimer();
  }

  render();

  return {
    update(next) {
      if (next.instructions) instructions = next.instructions;
      if (next.flags) flags = next.flags;
      if ('digest' in next) { digest = next.digest || null; glossary = digest ? glossaryOf(digest) : null; }
      const y = window.scrollY;
      render();
      window.scrollTo(0, y);
    },
    stats() {
      return { started_ms, verified_count: instructions.filter(i => i.verified).length, per_row_ms: [...perRow.values()] };
    },
    destroy() {
      destroyed = true;
      clearInterval(tick);
      closeSheet();
      root.remove();
    },
  };
}
