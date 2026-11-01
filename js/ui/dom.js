// Tiny DOM helpers shared by the UI screens.
const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'textContent']);

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (PROPS.has(k)) el[k] = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export function fmtOm(om, decimals = 2) {
  if (om == null || Number.isNaN(om)) return '—';
  return Number(om).toFixed(decimals == null ? 2 : decimals);
}
export function fmtPause(s) {
  if (s == null) return '—';
  return `${s} s (${(s / 60).toFixed(2)} min)`;
}

const DIR_WORD = { L: 'L', R: 'R', S: 'Straight', BL: 'Bear L', BR: 'Bear R' };
const CUE_WORD = { T: 'T', Y: 'Y', stop: 'STOP sign', yield: 'YIELD sign', signal: 'signal', sign: 'sign', om: 'OM', landmark: 'landmark' };

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function actionSummary(ins) {
  let main;
  switch (ins.action) {
    case 'turn': {
      main = DIR_WORD[ins.dir] || 'Turn';
      if (ins.cue) main += ' at ' + (ins.count ? ordinal(ins.count) + ' ' : '') + (CUE_WORD[ins.cue] || ins.cue);
      if (ins.landmark) main += ` (${ins.landmark})`;
      if (ins.onto) main += ` onto ${ins.onto}`;
      if (ins.sign_text) main += ` [sign: ${ins.sign_text}]`;
      break;
    }
    case 'cast': main = `CAST ${ins.cast_mph ?? '?'}`; break;
    case 'pause': main = `PAUSE ${fmtPause(ins.pause_s)}`; break;
    case 'gain': main = `GAIN ${ins.gain_s ?? 0} s`; break;
    case 'zone_start': main = `${ins.zone === 'transit' ? 'TRANSIT' : 'FREE'} ZONE start`; break;
    case 'zone_end': main = `${ins.zone === 'transit' ? 'TRANSIT' : 'FREE'} ZONE end`; break;
    case 'zero_odo': main = 'ZERO ODO'; break;
    case 'control': main = `${(ins.control || 'control').toUpperCase()} CONTROL`; break;
    default: main = ins.text || 'Note';
  }
  const parts = [main];
  if (ins.action !== 'turn' && ins.dir) parts.push(DIR_WORD[ins.dir] || ins.dir);
  if (ins.action !== 'turn' && ins.onto) parts.push(`onto ${ins.onto}`);
  if (ins.action !== 'cast' && ins.cast_mph != null) parts.push(`CAST ${ins.cast_mph}`);
  if (ins.action !== 'pause' && ins.pause_s) parts.push(`PAUSE ${ins.pause_s} s`);
  if (ins.action !== 'gain' && ins.gain_s) parts.push(`GAIN ${ins.gain_s} s`);
  if (ins.zone && ins.action !== 'zone_start' && ins.action !== 'zone_end') parts.push(`${ins.zone.toUpperCase()} ZONE${ins.zone_edge ? ` ${ins.zone_edge}` : ''}`);
  if (ins.control && ins.action !== 'control') parts.push(`${ins.control.toUpperCase()} CONTROL`);
  if (ins.transit_s != null) parts.push(`transit ${ins.transit_s} s`);
  if (ins.restart_tod) parts.push(`restart ${ins.restart_tod}`);
  if (ins.reset_odo) parts.push('/0.00');
  return parts.join(' · ');
}

const DIR_ICON = { L: '⬅', R: '➡', S: '⬆', BL: '↖', BR: '↗' };
const ACT_ICON = { cast: '⚡', pause: '⏸', gain: '⏩', zone_start: '⚑', zone_end: '⚐', zero_odo: '0.00', control: '✔', note: '✎' };
export function actionIcon(ins) {
  if (ins.action === 'turn') return DIR_ICON[ins.dir] || '↱';
  return ACT_ICON[ins.action] || '•';
}

// ---- plain-English explanation of a route instruction (see core/explain.js) ----
import { explain } from '../core/explain.js';

// Returns an element: the sentence (signs as road-sign chips), then an optional warning and terms line.
export function explainEl(ins, { glossary = null, warn = true, terms = true, size = null } = {}) {
  const wrap = h('div', { class: 'ex' + (size ? ' ex-' + size : '') });
  let e;
  try { e = explain(ins || {}, { glossary }); } catch (err) { e = null; }
  if (!e) return wrap;
  const line = h('div', { class: 'ex-text' });
  for (const p of e.parts || []) {
    if (p.k === 'sign') line.appendChild(h('span', { class: 'sign-chip' }, p.t));
    else if (p.k === 'dir' || p.k === 'road' || p.k === 'num') line.appendChild(h('b', { class: 'ex-' + p.k }, p.t));
    else if (p.k === 'landmark') line.appendChild(h('i', { class: 'ex-landmark' }, p.t));
    else line.appendChild(document.createTextNode(p.t));
  }
  wrap.appendChild(line);
  if (warn && e.warn) wrap.appendChild(h('div', { class: 'ex-warn' }, '⚠ ' + e.warn));
  if (terms && e.terms && e.terms.length) {
    wrap.appendChild(h('div', { class: 'ex-terms' }, e.terms.map(t => `${t.term} = ${t.meaning}`).join(' · ')));
  }
  return wrap;
}

// ---- GI rules digest (shared by verify and navigator) ----
// Returns an array of elements: special instructions first, then important rules, then the rest collapsed.
export function digestEls(d) {
  if (!d) return [];
  const out = [];
  const sis = d.special_instructions || [];
  const rules = d.rules || [];
  const imp = rules.filter(r => r.important), other = rules.filter(r => !r.important);
  const pg = (p) => (p ? h('span', { class: 'muted dg-pg' }, ` (p${p})`) : null);
  if (d.title) out.push(h('div', { class: 'dg-title' }, d.title));
  if (sis.length) {
    out.push(h('div', { class: 'dg-h dg-si-h' }, 'Special instructions: apply all along the route'));
    out.push(h('div', { class: 'dg-si' }, sis.map(s => h('div', { class: 'dg-item' }, h('b', null, (s.label || 'SI') + ': '), s.text, pg(s.page)))));
  }
  const facts = [];
  if (d.start) facts.push(h('div', { class: 'dg-item' }, h('b', null, 'Start: '), typeof d.start === 'string' ? d.start : JSON.stringify(d.start)));
  if (d.pause_units) facts.push(h('div', { class: 'dg-item' }, h('b', null, 'Pauses are in: '), String(d.pause_units)));
  if (d.timing_unit) facts.push(h('div', { class: 'dg-item' }, h('b', null, 'Timing: '), String(d.timing_unit)));
  if (facts.length) out.push(h('div', { class: 'dg-facts' }, facts));
  if (d.conflicts && d.conflicts.length) {
    out.push(h('div', { class: 'dg-h dg-conf-h' }, '⚠ Conflicts between pages'));
    out.push(h('div', { class: 'dg-conf' }, d.conflicts.map(c => h('div', { class: 'dg-item' }, typeof c === 'string' ? c : (c.message || c.text || JSON.stringify(c))))));
  }
  if (imp.length) {
    out.push(h('div', { class: 'dg-h' }, 'Important rules'));
    out.push(h('div', null, imp.map(r => h('div', { class: 'dg-item dg-imp' }, h('b', null, r.topic ? r.topic + ': ' : ''), r.text, pg(r.page)))));
  }
  if (other.length) out.push(h('details', { class: 'dg-more' }, h('summary', null, `Other rules (${other.length})`),
    other.map(r => h('div', { class: 'dg-item' }, h('b', null, r.topic ? r.topic + ': ' : ''), r.text, pg(r.page)))));
  const defs = d.definitions || [];
  if (defs.length) out.push(h('details', { class: 'dg-more' }, h('summary', null, `Definitions (${defs.length})`),
    defs.map(x => h('div', { class: 'dg-item' }, h('b', null, x.term + ' = '), x.meaning, pg(x.page)))));
  if (!out.length) out.push(h('div', { class: 'muted' }, 'No rules were found in the general instructions.'));
  return out;
}
