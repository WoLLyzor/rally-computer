// Time table: what the instructions expect, segment by segment (from the start, each restart and each
// control's out time). Elapsed times count from the segment's start; times of day where the start is known.
import { h, clear, fmtOm } from './dom.js';
import { fmtTod } from '../core/instruction.js';

const p2 = (x) => String(x).padStart(2, '0');
// Time of day to the tenth of a second (or HH:MM.cc in hundredths of a minute).
function tod(t, unit) {
  if (t === null || t === undefined || !Number.isFinite(t)) return '—';
  if (unit === 'cent') return fmtTod(t, 'cent');
  t = ((t % 86400) + 86400) % 86400;
  const tenths = Math.round(t * 10);
  const s = Math.floor(tenths / 10), hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60);
  return `${p2(hh)}:${p2(mm)}:${p2(s % 60)}.${tenths % 10}`;
}
// Elapsed time: m:ss.s, or minutes and hundredths.
function dur(s, unit) {
  if (s === null || s === undefined || !Number.isFinite(s)) return '—';
  if (unit === 'cent') return (s / 60).toFixed(2);
  const tenths = Math.round(s * 10), whole = Math.floor(tenths / 10), m = Math.floor(whole / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${p2(m % 60)}:${p2(whole % 60)}.${tenths % 10}` : `${m}:${p2(whole % 60)}.${tenths % 10}`;
}

function startText(seg, { unit, carNumber }) {
  const { kind, tod: t, row, n } = seg.start;
  const at = tod(t, unit);
  if (kind === 'start') return `Start at ${at} (car ${carNumber})`;
  if (kind === 'restart') return `Restart at ${at}${row.restart_plus_car ? ` (${row.restart_tod} + car ${carNumber})` : ''}`;
  if (kind === 'minute') return t !== null ? `Restart at ${at} (the minute you left)` : 'Restart on any minute you choose: times count from it';
  if (kind === 'flying') return t !== null ? `Flying restart at ${at}` : 'Flying restart: times count from crossing the line';
  return `Out of control #${n} at ${at}${row.control === 'open' ? ' (in + 2:00 until the real out time is entered)' : ''}`;
}

function note(x, unit) {
  const r = x.row, out = [];
  if (r.D === null && (r.cast_mph > 0 || r.pause_s > 0 || r.gain_s > 0 || r.restart_any)) out.push('at a sign with no mileage: times after it assume no change until you MARK it');
  if (r.pause_s > 0) out.push(`pause ${dur(r.pause_s, unit)}, leave ${tod(x.todLeave, unit)}`);
  if (r.gain_s > 0) out.push(`gain ${dur(r.gain_s, unit)}`);
  if (r.zone === 'transit') out.push(r.zone_edge === 'end' ? 'transit ends' : `transit${r.transit_s ? ` (${dur(r.transit_s, unit)} allowed)` : ''}`);
  if (r.zone === 'free') out.push(r.zone_edge === 'end' ? 'free zone ends' : 'free zone');
  if (r.action === 'control') out.push(`control${r.control ? ` (${r.control})` : ''}`);
  return out.join(' · ');
}

// segs: segmentTable(); opts: { unit, carNumber, tas: number of time allowances included }
export function renderTimes(container, segs, opts = {}) {
  const unit = opts.unit || 's';
  clear(container);
  const root = h('div', { class: 'times' });
  root.append(h('p', { class: 'muted' },
    `Expected times from the instructions. "Elapsed" counts from each segment's start, so it holds even when you choose the start minute. `
    + (opts.tas ? `Includes your ${opts.tas} time allowance${opts.tas > 1 ? 's' : ''} so far. ` : 'No time allowances included. ')
    + (unit === 'cent' ? 'Times in minutes and hundredths.' : 'Times to the tenth of a second.')));
  if (!segs.length) root.append(h('p', {}, 'No instructions loaded yet.'));
  for (const seg of segs) {
    const end = seg.end;
    root.append(h('section', { class: 'times-seg' },
      h('h2', {}, `Segment ${seg.k} · from #${seg.start.n}`),
      h('div', { class: 'times-start' }, startText(seg, { unit, carNumber: opts.carNumber ?? 0 })),
      end && end.fromMi !== null ? h('div', { class: 'times-end' },
        `To #${end.n}: ${end.fromMi.toFixed(2)} mi in ${dur(end.elapsed, unit)}`, end.tod !== null ? `, arriving ${tod(end.tod, unit)}` : '') : null,
      h('table', {},
        h('thead', {}, h('tr', {}, ['#', 'OM', 'CAST', 'From start', 'Elapsed', 'Time of day', 'Instruction'].map((c) => h('th', {}, c)))),
        h('tbody', {}, seg.rows.map((x) => h('tr', { class: x.first ? 'times-first' : '' },
          h('td', {}, String(x.n)),
          h('td', {}, x.om === null ? '—' : fmtOm(x.om)),
          h('td', {}, x.cast ? String(x.cast) : '—'),
          h('td', {}, x.fromMi === null ? '—' : x.fromMi.toFixed(2)),
          h('td', { class: 'num' }, dur(x.elapsed, unit)),
          h('td', { class: 'num' }, tod(x.tod, unit)),
          h('td', {}, x.row.text || '', note(x, unit) ? h('div', { class: 'muted' }, note(x, unit)) : null)))))));
  }
  container.append(root);
}
