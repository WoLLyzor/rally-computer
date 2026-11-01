// Instruction format (design §4) and the automatic verification checks (§6.2).
// Pure logic: no DOM, importable from Node tests.

export const ACTIONS = ['turn', 'cast', 'pause', 'gain', 'zone_start', 'zone_end', 'zero_odo', 'control', 'note'];
export const CUES = ['T', 'Y', 'stop', 'yield', 'signal', 'sign', 'om', 'landmark'];
export const DIRS = ['L', 'R', 'S', 'BL', 'BR', 'U'];
// How the action relates to the referenced sign or landmark: `R after "SLOW"` turns at the first
// chance after passing it; `L opposite "BARN"` where it stands across the road.
export const SIGN_RELS = ['at', 'after', 'before', 'past', 'opposite'];

// Defaults for every field. §4 fields first, then the v0 extensions (sign_rel/sign_side/note:
// rally-language details for the crew; pause_text: the amount as printed, for the GIs' pause units).
export function blankInstruction(n = null) {
  return {
    n, section: 1, om: null, om_decimals: null,
    text: '', action: 'note', dir: null, cue: null,
    onto: null, sign_text: null, landmark: null, count: null,
    cast_mph: null, pause_s: 0, gain_s: 0, zone: null, control: null,
    reset_odo: false, odo_check_end: false, restart_tod: null, restart_any: null, transit_s: null,
    sign_rel: null, sign_side: null, note: null, pause_text: null, gain_text: null, zone_edge: null,
    src: null, confidence: 1, verified: false, review: [],
  };
}

// Whether a row starts or ends its zone. A turn row can do it too (`L onto X. Begin FREE ZONE`).
export function zoneEdge(r) {
  if (!r.zone) return null;
  return r.action === 'zone_start' ? 'start' : r.action === 'zone_end' ? 'end' : r.zone_edge ?? null;
}

export function normalizeInstruction(raw) {
  const ins = { ...blankInstruction(), ...raw };
  ins.n = toInt(ins.n);
  ins.section = toInt(ins.section) || 1;
  ins.om = toNum(ins.om);
  if (ins.om !== null && (ins.om_decimals === null || ins.om_decimals === undefined)) ins.om_decimals = 2;
  ins.cast_mph = toNum(ins.cast_mph);
  ins.pause_s = toNum(ins.pause_s) || 0;
  ins.gain_s = toNum(ins.gain_s) || 0;
  ins.transit_s = toNum(ins.transit_s);
  if (!ACTIONS.includes(ins.action)) ins.action = 'note';
  if (ins.dir !== null && !DIRS.includes(ins.dir)) ins.dir = null;
  if (ins.cue !== null && !CUES.includes(ins.cue)) ins.cue = null;
  if (ins.sign_rel !== null && !SIGN_RELS.includes(ins.sign_rel)) ins.sign_rel = null;
  if (ins.sign_side !== null && ins.sign_side !== 'L' && ins.sign_side !== 'R') ins.sign_side = null;
  if (ins.note !== null && (typeof ins.note !== 'string' || !ins.note.trim())) ins.note = null;
  if (ins.zone_edge !== 'start' && ins.zone_edge !== 'end') ins.zone_edge = null;
  if (!Array.isArray(ins.review)) ins.review = [];
  return ins;
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const x = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(x) ? x : null;
}
function toInt(v) {
  const x = toNum(v);
  return x === null ? null : Math.round(x);
}

// "HH:MM:SS" or "HH:MM" or "HH:MM.cc" (cents) → seconds of day.
export function parseTod(s) {
  if (s === null || s === undefined) return null;
  if (typeof s === 'number') return s;
  const m = String(s).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?)|\.(\d{2}))?$/);
  if (!m) return null;
  let t = +m[1] * 3600 + +m[2] * 60;
  if (m[3] !== undefined) t += parseFloat(m[3]);
  if (m[4] !== undefined) t += +m[4] * 0.6;
  return t;
}

export function fmtTod(t, unit = 's') {
  if (t === null || t === undefined || !Number.isFinite(t)) return '--:--:--';
  t = ((t % 86400) + 86400) % 86400;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t - h * 3600) / 60);
  const rest = t - h * 3600 - m * 60;
  const p2 = (x) => String(x).padStart(2, '0');
  if (unit === 'cent') return `${p2(h)}:${p2(m)}.${p2(Math.floor(rest / 0.6 + 1e-9))}`;
  return `${p2(h)}:${p2(m)}:${p2(Math.floor(rest + 1e-9))}`;
}

// Legs: a timing control (open or DIYC) ends a leg. Returns [{leg, from_n, to_n, label}].
export function computeLegs(instructions) {
  const rows = [...instructions].sort((a, b) => a.n - b.n);
  const legs = [];
  let start = rows.length ? rows[0].n : 1;
  for (const r of rows) {
    if (r.action === 'control' && (r.control === 'open' || r.control === 'diyc')) {
      legs.push({ leg: legs.length + 1, from_n: start, to_n: r.n, label: `Leg ${legs.length + 1}` });
      start = r.n + 1;
    }
  }
  const last = rows.length ? rows[rows.length - 1].n : 0;
  if (!legs.length || start <= last) legs.push({ leg: legs.length + 1, from_n: start, to_n: last, label: `Leg ${legs.length + 1}` });
  return legs;
}

// Sections: OM restarts from zero after a reset ("/0.00"). Assigns ins.section in place
// unless the source already numbered sections, and returns the section count.
export function assignSections(instructions) {
  const rows = [...instructions].sort((a, b) => a.n - b.n);
  let section = 1;
  for (const r of rows) {
    r.section = section;
    if (r.reset_odo || r.action === 'zero_odo') section += 1;
  }
  return section;
}

// §6.2 automatic checks. Returns Flag[] ({n, severity, kind, message}).
// pageRowCounts: optional {page: expectedRows} reported by the reader.
export function runChecks(instructions, { pageRowCounts = null } = {}) {
  const flags = [];
  const add = (n, severity, message, kind = 'TRANSCRIPTION') => flags.push({ n, severity, kind, message });
  const rows = [...instructions].sort((a, b) => a.n - b.n);
  if (!rows.length) { add(null, 'danger', 'No instructions read'); return flags; }

  // Numbers continuous, no duplicates.
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1].n, b = rows[i].n;
    if (b === a) add(b, 'danger', `Instruction ${b} appears twice`);
    else if (b !== a + 1) add(b, 'danger', a + 1 === b - 1 ? `Instruction ${a + 1} is missing` : `Instructions ${a + 1}–${b - 1} are missing`);
  }
  if (rows[0].n !== 1) add(rows[0].n, 'watch', `First instruction is ${rows[0].n}, not 1`);

  // OM increasing within each section; an OM drop without "/0.00" is a likely missed reset or misread.
  // Sections come from the reader when it numbered them, otherwise from the reset markers.
  const explicit = rows.some((r) => r.section > 1);
  const sectionOf = new Map();
  let s = 1;
  for (const r of rows) { sectionOf.set(r, explicit ? r.section : s); if (r.reset_odo || r.action === 'zero_odo') s++; }
  let prev = null;
  for (const r of rows) {
    if (r.om === null) continue;
    const same = prev && sectionOf.get(prev) === sectionOf.get(r);
    if (same && r.om < prev.om - 1e-9) {
      add(r.n, 'danger', `Mileage ${r.om.toFixed(2)} is less than ${prev.om.toFixed(2)} at #${prev.n}; misread digit or missing /0.00?`);
    }
    if (prev && !same && r.om > prev.om + 0.5 && r.om > 1.0) {
      add(r.n, 'watch', `Mileage restarted after /0.00 at #${prev.n} but reads ${r.om.toFixed(2)}; check the reset`);
    }
    if (r.om_decimals === 1) add(r.n, 'info', `Mileage ${r.om} has 1 decimal: approximate, not official`);
    prev = r;
  }

  for (const r of rows) {
    if (r.action === 'cast' && !(r.cast_mph > 0)) add(r.n, 'danger', 'CAST without a speed');
    if (r.cast_mph !== null && (r.cast_mph < 5 || r.cast_mph > 65)) add(r.n, 'danger', `CAST ${r.cast_mph} is implausible`);
    if (r.cast_mph !== null && r.cast_mph % 1 !== 0) add(r.n, 'watch', `CAST ${r.cast_mph} is not a whole number`);
    for (const [k, label] of [['pause_s', 'Pause'], ['gain_s', 'Gain']]) {
      const v = r[k];
      if (v < 0) add(r.n, 'danger', `${label} is negative`);
      else if (v > 600) add(r.n, 'danger', `${label} ${v} s is over 10 minutes; check the units`);
      else if (v > 0 && v < 3) add(r.n, 'watch', `${label} ${v} s is very short; check the units`);
    }
    if ((r.action === 'pause' && !(r.pause_s > 0)) || (r.action === 'gain' && !(r.gain_s > 0))) add(r.n, 'danger', `${r.action} without an amount`);
    if (r.action === 'turn' && !r.dir) add(r.n, 'danger', 'Turn without a direction');
    if (r.action === 'note' && r.confidence < 0.6) add(r.n, 'watch', 'Line not understood; read it yourself');
    if (r.action === 'zone_start' && !r.zone) add(r.n, 'watch', 'Zone start without a type (free or transit)');
  }

  // Zones balanced.
  const open = {};
  for (const r of rows) {
    if (zoneEdge(r) === 'start') { if (open[r.zone]) add(r.n, 'watch', `${r.zone} zone starts again before #${open[r.zone]}'s zone ended`); open[r.zone] = r.n; }
    if (zoneEdge(r) === 'end') { if (!open[r.zone]) add(r.n, 'watch', `${r.zone} zone ends but never started`); open[r.zone] = null; }
  }
  for (const [z, n] of Object.entries(open)) if (n) add(n, 'watch', `${z} zone never ends`);

  // Reset markers found: if OM drops a lot and no reset anywhere, say so globally.
  const resets = rows.filter((r) => r.reset_odo || r.action === 'zero_odo');
  if (!resets.length && rows.some((r, i) => i > 0 && r.om !== null && rows[i - 1].om !== null && r.om < rows[i - 1].om - 1)) {
    add(null, 'watch', 'No /0.00 reset marker was read, but mileage goes back to zero somewhere');
  }

  // Row count matches the page.
  if (pageRowCounts) {
    for (const [page, expected] of Object.entries(pageRowCounts)) {
      const got = rows.filter((r) => r.src && String(r.src.page) === String(page)).length;
      if (expected !== null && got !== expected) add(null, 'danger', `Page ${page}: read ${got} rows but the page shows ${expected}`);
    }
  }

  // Two-pass disagreements.
  for (const r of rows) {
    for (const d of r.review || []) add(r.n, 'watch', `Readings disagree on ${d.field}: ${fmtVal(d.a)} vs ${fmtVal(d.b)}`);
  }
  return flags;
}

function fmtVal(v) {
  if (v === null || v === undefined) return '—';
  return typeof v === 'number' ? String(v) : `"${v}"`;
}
