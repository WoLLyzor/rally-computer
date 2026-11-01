// Two-pass Claude vision extraction (cloud profile, design §6 step 1). Used only with the
// rallymaster's written OK. The caller passes an Anthropic SDK client: in the browser the bundled
// app/vendor/anthropic-sdk.mjs with dangerouslyAllowBrowser, in Node the @anthropic-ai/sdk package.
//
// Pass A reads each row into structured fields and says what kind of page it is. Pass B is an
// independent proofreading transcription whose text goes through the deterministic rally-language
// parser. Rows where the passes disagree carry `review` entries and go first in the driver's verify
// queue; every row is still verified. Pages of general instructions (GIs, definitions) get pass G
// instead: the event's own definitions, rules and standing instructions, merged into a digest.

import { parseLine, parsePauseAmount, splitMargin } from './parser.js';
import { blankInstruction, normalizeInstruction, zoneEdge } from './instruction.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const MAX_EDGE = 2576;   // long-edge limit for high-resolution vision

export class ExtractError extends Error {
  constructor(kind, message, detail = null) { super(message); this.kind = kind; this.detail = detail; }
}

const str = { type: 'string' };
const ROW_A = {
  type: 'object',
  properties: {
    n: { type: 'integer' }, label: str, om: str, text: str,
    action: { type: 'string', enum: ['turn', 'cast', 'pause', 'gain', 'zone_start', 'zone_end', 'zero_odo', 'control', 'note'] },
    dir: { type: 'string', enum: ['L', 'R', 'S', 'BL', 'BR', 'U', ''] },
    cue: { type: 'string', enum: ['T', 'Y', 'stop', 'yield', 'signal', 'sign', 'om', 'landmark', ''] },
    onto: str, sign_text: str, sign_rel: { type: 'string', enum: ['at', 'after', 'before', 'past', 'opposite', ''] },
    sign_side: { type: 'string', enum: ['L', 'R', ''] }, landmark: str, count: { type: 'integer' }, cast_mph: { type: 'number' },
    pause: str, gain: str,
    zone: { type: 'string', enum: ['free', 'transit', ''] }, zone_edge: { type: 'string', enum: ['start', 'end', ''] },
    control: { type: 'string', enum: ['open', 'passage', 'diyc', 'gps', ''] },
    reset_odo: { type: 'boolean' }, restart_tod: str, note: str,
    y_top: { type: 'number' }, y_bottom: { type: 'number' }, legible: { type: 'boolean' },
  },
  required: ['n', 'label', 'om', 'text', 'action', 'dir', 'cue', 'onto', 'sign_text', 'sign_rel', 'sign_side', 'landmark', 'count',
    'cast_mph', 'pause', 'gain', 'zone', 'zone_edge', 'control', 'reset_odo', 'restart_tod', 'note', 'y_top', 'y_bottom', 'legible'],
  additionalProperties: false,
};
export const PAGE_KINDS = ['route', 'general', 'other'];
export const SCHEMA_A = {
  type: 'object',
  properties: { page_kind: { type: 'string', enum: PAGE_KINDS }, rows_on_page: { type: 'integer' }, rows: { type: 'array', items: ROW_A } },
  required: ['page_kind', 'rows_on_page', 'rows'], additionalProperties: false,
};
export const SCHEMA_B = {
  type: 'object',
  properties: {
    row_count: { type: 'integer' },
    rows: { type: 'array', items: { type: 'object', properties: {
      number_text: str, mileage_text: str, text: str, y_top: { type: 'number' }, y_bottom: { type: 'number' }, uncertain: { type: 'boolean' },
    }, required: ['number_text', 'mileage_text', 'text', 'y_top', 'y_bottom', 'uncertain'], additionalProperties: false } },
  },
  required: ['row_count', 'rows'], additionalProperties: false,
};
const listOf = (props) => ({ type: 'array', items: { type: 'object', properties: props, required: Object.keys(props), additionalProperties: false } });
export const SCHEMA_G = {
  type: 'object',
  properties: {
    title: str,
    definitions: listOf({ term: str, meaning: str }),
    rules: listOf({ topic: { type: 'string', enum: ['signs', 'route_following', 'timing', 'controls', 'time_allowance', 'penalties', 'safety', 'start_finish', 'equipment', 'other'] },
      text: str, important: { type: 'boolean' } }),
    special_instructions: listOf({ label: str, text: str }),
    pause_units: { type: 'string', enum: ['minutes', 'seconds', 'hundredths', 'not_stated'] },
    timing_unit: { type: 'string', enum: ['seconds', 'hundredths', 'not_stated'] },
    start: str,
  },
  required: ['title', 'definitions', 'rules', 'special_instructions', 'pause_units', 'timing_unit', 'start'],
  additionalProperties: false,
};

export const PROMPT_A = `This is a photo of one page from the instruction packet of an SCCA road rally (time-speed-distance or course rally).

First decide page_kind:
- route: the page has numbered route instructions (a number, usually a mileage column, then the instruction).
- general: general instructions (GIs), definitions, abbreviations, rules or special instructions written as prose or lists.
- other: anything else (maps, score cards, checkpoint or time-allowance slips, blank pages).
For general and other pages return rows: [] and rows_on_page: 0.

On a route page, transcribe every route instruction in order from top to bottom. For each row give:
- n: the instruction number as printed. A lettered or special instruction ("A.", "SI 3") gets n 0 and its label in label; otherwise label is "".
- om: the mileage column exactly as printed, for example "7.42", "07.42", "10.53/0.00" or "/0.00". Use "" when the row has no mileage.
- text: the instruction text exactly as printed. Keep abbreviations, quote marks and capitalization; join wrapped lines with one space.
- The meaning, using only what is printed and the standard rally conventions:
  - Text in quotation marks is the wording of a SIGN. R at "BEAR" means turn right at a sign with the word BEAR on it, not at a bear or a picture of one: cue sign, sign_text BEAR. Copy sign_text exactly as quoted, without the quote marks.
  - Unquoted STOP, YIELD, T, Y, END, light/signal/TL, RRX, church, bridge and so on are the real things: cue stop, yield, T (also END of road), Y, signal, or landmark with the landmark word.
  - SL 45 means the 45 mph speed-limit sign: cue sign, sign_text SPEED LIMIT 45.
  - Common abbreviations: @ = at, B4 = before, SO = straight on, SS = stop sign, TL = traffic light, RRX or RxR = railroad crossing, OP or OPP = opportunity, BFZ/EFZ = begin/end free zone, BTZ/ETZ = begin/end transit zone, SRIP = the quoted words are part of the sign. Keep ITIS (do it only if the reference turns up) in the text.
  - If an instruction is drawn as a tulip diagram (a junction sketch with an arrow) instead of words, put any printed words in text followed by a short description in square brackets, e.g. [diagram: right at T], and fill the fields from the drawing.
  - sign_rel: how the action relates to the sign or landmark: at, after (or "past", "beyond"), before, opposite ("OPP" right before a quoted sign); "" when there is no sign or landmark.
  - sign_side: L or R when the row says which side the sign is on (SOL, SOR, "sign on left"), else "".
  - onto: the road turned onto. "R on MAIN" and "R at T on 72" mean onto MAIN and 72. A road name in parentheses after a turn, as in L at 2nd light (HARRISON), is the road turned onto.
  - note: other remarks in parentheses or advice not captured by any field here, e.g. use turn pocket, ignore "ROAD CLOSED", sign may be missing; else "".
  - count: 2 for "2nd", "second" or "2nd OPP"; else 0. OPP alone means opportunity: a road you could legally turn onto.
  - dir: L, R, S (straight, SAP), BL or BR (bear, stay or keep left/right, Y forks), U (U-turn, turn around), or "".
  - action: turn, cast, pause, gain, zone_start, zone_end, zero_odo, control or note: the main thing the row asks for. A turn row that also starts or ends a zone keeps action turn, with zone and zone_edge set.
  - cast_mph: the new average speed, else 0. pause, gain: the amount exactly as printed (e.g. "0.20" or "30 SEC"), else "".
  - zone: free or transit when the row starts or ends a zone, else "". zone_edge: start or end for that zone, else "". control: open, passage, diyc or gps when the row is a checkpoint, else "".
  - reset_odo: true if the row re-zeroes the odometer ("/0.00" or a reset instruction). restart_tod: a printed restart or leave time as "HH:MM:SS", else "".
- y_top and y_bottom: the row's vertical extent as fractions of the image height (0 is the top edge).
- legible: false if any character of the number, mileage or text is uncertain.

Also report rows_on_page: count the numbered route instructions on the page (not lettered ones), separately from transcribing them. Do not invent, skip, merge or correct rows.`;

export const PROMPT_B = `Proofread this photographed page of road-rally route instructions. List every numbered row, top to bottom, character for character:
- number_text: the row number as printed.
- mileage_text: the mileage column as printed, including any "/0.00"; "" if blank.
- text: the instruction text exactly as printed, wrapped lines joined with one space.
- y_top and y_bottom: the row's vertical extent as fractions of the image height (0 is the top edge).
- uncertain: true if any character is hard to read.
Then give row_count: the number of numbered rows on the page. Transcribe only. Do not interpret, expand abbreviations or fix anything. If the page has no numbered route instructions, return no rows and row_count 0.`;

export const PROMPT_G = `This page is part of the general instructions (GIs), definitions or rules of an SCCA road rally. Extract what the crew needs while driving, in short plain sentences, using only what is printed on this page:
- definitions: every defined term or abbreviation with its meaning in one short line (for example OPP: opportunity, a road you could legally turn onto).
- rules: each rule that changes how route instructions are read, followed or timed, as one short sentence with its topic. Set important to true for anything that costs points or disqualifies, and for how quoted signs, counting, onto and the main or principal road work.
- special_instructions: standing instructions that apply along the route without a mileage (lettered or special instructions, "at every ..." rules), each with its label as printed.
- pause_units: whether pause and gain amounts are in minutes (decimal minutes), seconds, or hundredths of a minute (PAUSE 25 = 0.25 minute), if the page says; else not_stated.
- timing_unit: whether scoring is in seconds or hundredths of a minute, if the page says; else not_stated.
- start: the start time, car interval and odometer-check details if printed, else "".
- title: the rally's name if printed, else "".
Do not invent anything that is not printed.`;

function supportsFallbacks(model) {
  return /^claude-(opus-5|sonnet-5-5|fable-5)/.test(model);
}

// One vision pass. Streams (long output with adaptive thinking) and returns the parsed JSON.
export async function runPass(client, { model = DEFAULT_MODEL, effort = 'high', prompt, schema, image }) {
  const params = {
    model,
    max_tokens: 32000,
    output_config: { effort, format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
      { type: 'text', text: prompt },
    ] }],
  };
  if (supportsFallbacks(model)) { params.betas = [FALLBACK_BETA]; params.fallbacks = 'default'; }
  const stream = client.beta.messages.stream(params);
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw new ExtractError('refusal', 'The reader declined this page', msg.stop_details ?? null);
  if (msg.stop_reason === 'max_tokens') throw new ExtractError('truncated', 'The page reading was cut off');
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return { data: JSON.parse(text), usage: msg.usage, model: msg.model };
  } catch (e) {
    throw new ExtractError('bad_json', 'The page reading was not valid JSON', text.slice(0, 200));
  }
}

const normText = (s) => String(s ?? '').toUpperCase()
  .replace(/[“”„″]/g, '"').replace(/[‘’′`]/g, "'")
  .replace(/\s+([,.;:)])/g, '$1').replace(/\(\s+/g, '(').replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim();
const normName = (s) => (s ? normText(s).replace(/^["']|["']$/g, '') : null);
const empty = (v) => (v === '' || v === undefined ? null : v);

function omFields(omText) {
  const t = String(omText ?? '').trim();
  if (!t) return { om: null, om_decimals: null, reset_odo: false };
  const m = splitMargin(`1 ${t} X`);
  return { om: m.om, om_decimals: m.om_decimals, reset_odo: m.reset_odo };
}

function bboxOf(row) {
  const top = Math.max(0, Math.min(1, row.y_top ?? 0));
  const bot = Math.max(top, Math.min(1, row.y_bottom ?? top));
  return [0, top, 1, Math.max(0.005, bot - top)];
}

// "0.30", "30 SEC", "1:30" → seconds; a bare number counts as minutes unless the GIs say seconds.
function amountS(s, pauseUnits = null) {
  if (!s) return 0;
  const m = String(s).toUpperCase().match(/(\d{1,2}:\d{2}|\d*\.\d+|\d+)\s*(MINUTES?|MINS?|M\b|SECONDS?|SECS?|S\b)?/);
  if (!m) return 0;
  if (pauseUnits === 'seconds' && !m[2] && !m[1].includes(':')) return parseFloat(m[1]);
  if (pauseUnits === 'hundredths' && !m[2] && /^\d+$/.test(m[1])) return Math.round(parseInt(m[1], 10) * 0.6 * 1000) / 1000;
  return parsePauseAmount(m[1], m[2]).seconds;
}

// Pass A row → Instruction (the model's reading of the fields).
export function fromRowA(row, page) {
  const om = omFields(row.om);
  // "SL 45" is the 45 mph speed-limit sign, a sign reference, however the reader labelled it.
  const sl = /^(?:SL|SPEED\s+LIMIT)\s*(\d{2})$/i.exec(String(row.landmark || row.sign_text || '').trim());
  if (sl && (row.cue === 'landmark' || row.cue === 'sign')) row = { ...row, cue: 'sign', sign_text: `SPEED LIMIT ${sl[1]}`, landmark: '', sign_rel: row.sign_rel || 'at' };
  return normalizeInstruction({
    ...blankInstruction(row.n), ...om,
    reset_odo: om.reset_odo || !!row.reset_odo,
    text: row.text, action: row.action, dir: empty(row.dir), cue: empty(row.cue),
    onto: empty(row.onto), sign_text: empty(row.sign_text), landmark: empty(row.landmark),
    sign_rel: empty(row.sign_rel), sign_side: empty(row.sign_side), note: empty(row.note),
    count: row.count > 0 ? row.count : null, cast_mph: row.cast_mph > 0 ? row.cast_mph : null,
    pause_s: amountS(row.pause), gain_s: amountS(row.gain), pause_text: empty(row.pause), gain_text: empty(row.gain),
    zone: empty(row.zone), zone_edge: empty(row.zone_edge), control: empty(row.control),
    restart_tod: empty(row.restart_tod), src: { page, bbox: bboxOf(row) },
    confidence: row.legible === false ? 0.7 : 0.98,
  });
}

// Pass B row → Instruction via the deterministic parser.
export function fromRowB(row, page) {
  const ins = parseLine(`${row.number_text} ${row.mileage_text || ''} ${row.text}`.replace(/\s+/g, ' '));
  ins.src = { page, bbox: bboxOf(row) };
  ins.text = row.text;
  if (row.uncertain) ins.confidence = Math.min(ins.confidence, 0.7);
  return ins;
}

const INTERP_FIELDS = ['action', 'dir', 'cue', 'onto', 'sign_text', 'sign_rel', 'cast_mph', 'pause_s', 'gain_s', 'zone', 'zone_edge', 'control', 'reset_odo', 'restart_tod', 'count'];
const sameVal = (f, a, b) => {
  if (f === 'cue') return (a === 'om' ? null : a ?? null) === (b === 'om' ? null : b ?? null);   // "om" = no cue but the mileage
  if (['onto', 'sign_text'].includes(f)) return normName(a) === normName(b);
  if (typeof a === 'number' || typeof b === 'number') return Math.abs((a ?? 0) - (b ?? 0)) < 1e-6;
  return (a ?? null) === (b ?? null);
};
const LETTER_LABEL = /^(?:[A-Z]|S\.?I\.?\s*-?\s*\d+|SPECIAL\b.*)[.):]?$/i;

// Merge the two passes of one page. Pass A supplies the fields; pass B is the independent check.
// Pages that pass A calls general or other give no rows (their content goes to pass G or nowhere).
export function mergePage(dataA, dataB, page) {
  const kind = dataA?.page_kind ?? 'route';
  if (kind !== 'route') return { rows: [], standing: [], kind, counts: { a: 0, b: null, readA: 0, readB: 0 } };
  const standing = (dataA?.rows || []).filter((r) => r.label).map((r) => ({ label: r.label, text: r.text, page }));
  const rowsA = (dataA?.rows || []).filter((r) => !r.label).map((r) => fromRowA(r, page));
  const rowsB = (dataB?.rows || []).filter((r) => !LETTER_LABEL.test(String(r.number_text ?? '').trim())).map((r) => fromRowB(r, page));
  const byNB = new Map(rowsB.map((r, i) => [r.n ?? `i${i}`, r]));
  const out = [];
  const seen = new Set();
  rowsA.forEach((a, i) => {
    const key = a.n ?? `i${i}`;
    const b = byNB.get(key);
    seen.add(key);
    const review = [];
    if (!b) review.push({ field: 'row', a: 'read', b: 'missing', kind: 'transcription' });
    else {
      if (!sameVal('om', a.om, b.om)) review.push({ field: 'om', a: a.om, b: b.om, kind: 'transcription' });
      if (a.reset_odo !== b.reset_odo) review.push({ field: '/0.00', a: a.reset_odo, b: b.reset_odo, kind: 'transcription' });
      if (normText(a.text) !== normText(b.text)) review.push({ field: 'text', a: a.text, b: b.text, kind: 'transcription' });
    }
    // Interpretation: the model's fields vs. the parser's reading of the same text.
    const p = parseLine(`${a.n ?? ''} ${a.text}`);
    // Fields only the parser reads (fixed phrases): odometer-check ends, "+ car number", transit allowances.
    if (p.odo_check_start) a.odo_check_start = true;
    if (p.odo_check_end) a.odo_check_end = true;
    if (p.restart_plus_car) a.restart_plus_car = true;
    if (p.restart_any && !a.restart_tod) a.restart_any = p.restart_any;
    if (a.transit_s == null && p.transit_s != null) a.transit_s = p.transit_s;
    if (p.confidence >= 0.85) {
      for (const f of INTERP_FIELDS) {
        if (f === 'reset_odo') continue;   // the margin decides that, compared above
        if (f === 'zone_edge' ? zoneEdge(a) === zoneEdge(p) : sameVal(f, a[f], p[f])) continue;
        // A quoted road name read as the sign by one reader and only as the road by the other.
        if (f === 'sign_text' && [a[f], p[f]].every((v) => v == null || v === '' || normName(v) === normName(a.onto ?? p.onto))) continue;
        // The relation only matters when both readers saw a sign or landmark.
        if (f === 'sign_rel' && (!a.cue || !p.cue || (a[f] ?? 'at') === (p[f] ?? 'at'))) continue;
        review.push({ field: f, a: f === 'zone_edge' ? zoneEdge(a) : a[f], b: f === 'zone_edge' ? zoneEdge(p) : p[f], kind: 'interpretation' });
      }
    }
    const transcriptionIssue = review.some((r) => r.kind === 'transcription');
    const conf = Math.min(a.confidence, b ? b.confidence : 0.5) * (transcriptionIssue ? 0.6 : review.length ? 0.8 : 1);
    out.push({ ...a, review, confidence: Math.round(conf * 100) / 100 });
  });
  rowsB.forEach((b, i) => {
    const key = b.n ?? `i${i}`;
    if (seen.has(key)) return;
    out.push({ ...b, review: [{ field: 'row', a: 'missing', b: 'read', kind: 'transcription' }], confidence: Math.min(b.confidence, 0.5) });
  });
  out.sort((x, y) => (x.n ?? 1e9) - (y.n ?? 1e9));
  const counts = { a: dataA?.rows_on_page ?? null, b: dataB?.row_count ?? null, readA: rowsA.length, readB: rowsB.length };
  return { rows: out, standing, kind, counts };
}

// The event's own rules from its GI pages: definitions, rules, standing instructions, units.
export function buildDigest(gPages) {
  const d = { title: '', definitions: [], rules: [], special_instructions: [], pause_units: null, timing_unit: null, start: '', pages: [], conflicts: [] };
  const terms = new Set();
  for (const { page, data } of gPages) {
    if (!data) continue;
    d.pages.push(page);
    if (!d.title && data.title) d.title = data.title.trim();
    for (const x of data.definitions || []) {
      const k = String(x.term || '').trim().toUpperCase();
      if (k && !terms.has(k)) { terms.add(k); d.definitions.push({ term: x.term.trim(), meaning: String(x.meaning || '').trim(), page }); }
    }
    for (const x of data.rules || []) if (x.text) d.rules.push({ topic: x.topic, text: x.text.trim(), important: !!x.important, page });
    for (const x of data.special_instructions || []) if (x.text) d.special_instructions.push({ label: String(x.label || '').trim(), text: x.text.trim(), page });
    for (const k of ['pause_units', 'timing_unit']) {
      const v = data[k];
      if (!v || v === 'not_stated') continue;
      if (d[k] && d[k] !== v) d.conflicts.push(`${k.replace('_', ' ')}: ${d[k]} or ${v} (page ${page})`); else d[k] = v;
    }
    if (!d.start && data.start) d.start = data.start.trim();
  }
  return d;
}

// Glossary for the explainer from the digest's definitions (short single-token terms only).
export function glossaryOf(digest) {
  const g = {};
  for (const x of digest?.definitions || []) {
    const t = x.term.toUpperCase().replace(/["“”]/g, '').trim();
    if (/^[A-Z0-9][A-Z0-9 .&-]{0,14}$/.test(t)) g[t] = x.meaning;
  }
  return g;
}

function retryable(e) {
  if (e instanceof ExtractError) return e.kind === 'bad_json' || e.kind === 'truncated';
  const st = e?.status;
  return st === undefined || st === null || st === 408 || st === 409 || st === 429 || st >= 500;   // network errors carry no status
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Read every page (A + B; G for GI pages), several at a time, retrying failed passes once, and merge.
//   pages: [{page, image: {mediaType, data(base64)} | () => Promise<image>}]
//   cached: {page: {A, B, G}} results from an earlier run (resume after a reload or a failure)
//   onProgress({page, pass, state: running|done|retry|error|skipped, message, kind})
//   onResult(page, pass, result) — persist each finished pass as it arrives
// Returns {instructions, standing, digest, pageKinds, pageRowCounts, pageFlags, failedPages, usage, results}.
export async function extractPages(client, pages, { modelA = DEFAULT_MODEL, modelB = DEFAULT_MODEL, modelG = DEFAULT_MODEL,
  effortA = 'high', effortB = 'high', effortG = 'medium', concurrency = 4, retries = 1, retryDelayMs = 3000,
  cached = {}, onProgress = () => {}, onResult = () => {} } = {}) {
  const results = {};
  for (const p of pages) results[p.page] = { ...(cached[p.page] || {}) };
  const ok = (page, pass) => !!results[page]?.[pass]?.data;
  const kindOf = (page) => results[page]?.A?.data?.page_kind ?? null;
  // An image may be given as a function that prepares it, so reading starts before every photo is resized.
  const image = Object.fromEntries(pages.map((p) => [p.page, p.image]));
  const imageOf = async (page) => (typeof image[page] === 'function' ? (image[page] = await image[page]()) : image[page]);
  const run = { A: (img) => runPass(client, { model: modelA, effort: effortA, prompt: PROMPT_A, schema: SCHEMA_A, image: img }),
    B: (img) => runPass(client, { model: modelB, effort: effortB, prompt: PROMPT_B, schema: SCHEMA_B, image: img }),
    G: (img) => runPass(client, { model: modelG, effort: effortG, prompt: PROMPT_G, schema: SCHEMA_G, image: img }) };
  const usage = { input_tokens: 0, output_tokens: 0 };

  // Pass A says what the page is, so B (route pages) and G (general pages) are queued after it: no
  // proofreading pass is spent on a GI page or a map. The workers stay busy, so total time is the same.
  const queue = [];
  const after = (page) => {
    const k = kindOf(page) ?? 'route';     // pass A failed: pass B alone can still give the rows
    if (k === 'general' && !ok(page, 'G')) queue.unshift({ page, pass: 'G', tries: 0 });
    if (k === 'route' && !ok(page, 'B')) queue.push({ page, pass: 'B', tries: 0 });
  };
  for (const p of pages) { if (!ok(p.page, 'A')) queue.push({ page: p.page, pass: 'A', tries: 0 }); }
  for (const p of pages) { if (ok(p.page, 'A')) after(p.page); }
  let active = 0;
  const worker = async () => {
    while (queue.length) {
      const j = queue.shift();
      active++;
      onProgress({ page: j.page, pass: j.pass, state: 'running' });
      try {
        const r = await run[j.pass](await imageOf(j.page));
        results[j.page][j.pass] = r;
        usage.input_tokens += r.usage?.input_tokens || 0; usage.output_tokens += r.usage?.output_tokens || 0;
        onResult(j.page, j.pass, r);
        const kind = j.pass === 'A' ? r.data.page_kind ?? 'route' : kindOf(j.page) ?? 'route';
        const rows = (r.data.rows || []).length;
        onProgress({ page: j.page, pass: j.pass, state: 'done', kind, message: j.pass === 'G' ? `${(r.data.definitions || []).length} definitions, ${(r.data.rules || []).length} rules` : `${rows} rows` });
        if (j.pass === 'A') after(j.page);
      } catch (e) {
        if (j.tries < retries && retryable(e)) {
          onProgress({ page: j.page, pass: j.pass, state: 'retry', message: e.message });
          await sleep(retryDelayMs * (j.tries + 1));
          queue.push({ ...j, tries: j.tries + 1 });
        } else {
          results[j.page][j.pass] = { error: e };
          onProgress({ page: j.page, pass: j.pass, state: 'error', message: e.message });
          if (j.pass === 'A') after(j.page);
        }
      } finally { active--; }
    }
  };
  // Workers keep going while others still run: a general page can add a G job late.
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length || 1)) }, async () => {
    do { await worker(); if (active) await sleep(50); } while (queue.length || active);
  });
  await Promise.all(workers);

  const instructions = [], standing = [], pageFlags = [], failedPages = [], gPages = [];
  const pageRowCounts = {}, pageKinds = {}, firstPageOf = new Map();
  for (const p of pages) {
    const r = results[p.page] || {};
    const kind = kindOf(p.page) ?? (r.B?.data ? 'route' : null);
    pageKinds[p.page] = kind;
    if (kind === 'general') {
      if (r.G?.data) gPages.push({ page: p.page, data: r.G.data });
      else { failedPages.push(p.page); pageFlags.push({ n: null, severity: 'watch', kind: 'TRANSCRIPTION', message: `Page ${p.page} (general instructions) could not be summarized: ${r.G?.error?.message ?? 'not read'}` }); }
      continue;
    }
    if (kind === 'other') continue;
    if (r.A?.error && (r.B?.error || !r.B)) { failedPages.push(p.page); pageFlags.push({ n: null, severity: 'danger', kind: 'TRANSCRIPTION', message: `Page ${p.page} could not be read: ${r.A.error.message}` }); continue; }
    if (!r.A && !r.B) { failedPages.push(p.page); continue; }
    const merged = mergePage(r.A?.data, r.B?.data, p.page);
    if (r.A?.error || r.B?.error) { failedPages.push(p.page); pageFlags.push({ n: null, severity: 'watch', kind: 'TRANSCRIPTION', message: `Page ${p.page}: only one reading worked; check every row (or read the page again)` }); }
    const { a, b, readA, readB } = merged.counts;
    pageRowCounts[p.page] = a ?? b;
    if (a !== null && b !== null && a !== b) pageFlags.push({ n: null, severity: 'danger', kind: 'TRANSCRIPTION', message: `Page ${p.page}: the two readings count ${a} and ${b} rows` });
    if (a !== null && readA !== a) pageFlags.push({ n: null, severity: 'watch', kind: 'TRANSCRIPTION', message: `Page ${p.page}: counted ${a} rows but read ${readA}` });
    if (r.B?.data && r.A?.data && readB !== readA) pageFlags.push({ n: null, severity: 'watch', kind: 'TRANSCRIPTION', message: `Page ${p.page}: pass A read ${readA} rows, pass B ${readB}` });
    // The same instructions on two pages: one page photographed twice. Keep the first reading.
    const dup = merged.rows.filter((x) => x.n !== null && firstPageOf.has(x.n));
    if (dup.length) {
      const other = firstPageOf.get(dup[0].n);
      pageFlags.push({ n: null, severity: 'watch', kind: 'TRANSCRIPTION', message: `Pages ${other} and ${p.page} both have instruction${dup.length > 1 ? 's' : ''} ${dup[0].n}${dup.length > 1 ? `–${dup[dup.length - 1].n}` : ''}: the same page twice? The first reading is kept.` });
    }
    for (const x of merged.rows) {
      if (x.n !== null && firstPageOf.has(x.n)) continue;
      if (x.n !== null) firstPageOf.set(x.n, p.page);
      instructions.push(x);
    }
    standing.push(...merged.standing);
  }
  const digest = buildDigest(gPages);
  digest.special_instructions.push(...standing.filter((s) => !digest.special_instructions.some((d) => d.label === s.label && d.text === s.text)));
  // Pause and gain amounts printed without units follow the GIs when they say seconds. Once the GIs
  // state the unit, a bare number is no longer a doubt, so it doesn't send the row to review first.
  if (digest.pause_units === 'seconds' || digest.pause_units === 'hundredths') {
    const changed = [];
    for (const ins of instructions) {
      const p = amountS(ins.pause_text, digest.pause_units), g = amountS(ins.gain_text, digest.pause_units);
      if (ins.pause_text && p !== ins.pause_s) { ins.pause_s = p; changed.push(ins.n); }
      if (ins.gain_text && g !== ins.gain_s) { ins.gain_s = g; changed.push(ins.n); }
    }
    if (changed.length) pageFlags.push({ n: null, severity: 'info', kind: 'TRANSCRIPTION', message: `The GIs give pauses in ${digest.pause_units === 'seconds' ? 'seconds' : 'hundredths of a minute'}: read #${changed.join(', #')} that way` });
  }
  if (digest.pause_units) {
    const bare = (t) => t && /^\s*\d+(?:\.\d+)?\s*$/.test(t);
    for (const ins of instructions) if ((bare(ins.pause_text) || bare(ins.gain_text)) && !ins.review.length) ins.confidence = Math.max(ins.confidence, 0.92);
  }
  for (const c of digest.conflicts) pageFlags.push({ n: null, severity: 'watch', kind: 'TRANSCRIPTION', message: `The GI pages disagree on ${c}` });
  // Letters that mean different things at different rallies: say so when this event's GIs use another meaning.
  for (const d of digest.definitions) {
    const t = d.term.toUpperCase().replace(/[^A-Z]/g, '');
    if ((t === 'BL' && !/BEAR/i.test(d.meaning)) || (t === 'S' && !/STRAIGHT/i.test(d.meaning))) {
      pageFlags.push({ n: null, severity: 'danger', kind: 'TRANSCRIPTION', message: `The GIs define ${d.term} as "${d.meaning}", not ${t === 'BL' ? 'bear left' : 'straight'}: check every row that uses ${d.term}` });
    }
  }
  instructions.sort((x, y) => (x.n ?? 1e9) - (y.n ?? 1e9));
  return { instructions, standing, digest, pageKinds, pageRowCounts, pageFlags, failedPages: [...new Set(failedPages)], usage, results };
}

export { MAX_EDGE };
