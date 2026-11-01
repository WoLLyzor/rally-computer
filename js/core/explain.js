// Plain-English reading of a route instruction, for the screens and the voice (design §6.3, §7).
// Rally language is terse and full of traps: `R at "BEAR"` means a sign with the word BEAR on it — not
// a bear and not a picture of one — while unquoted words (STOP, T, CHURCH) are the real things. Works
// offline from the parsed fields; the event's own definitions (the GI digest) extend the glossary.

// Common rally abbreviations (2026 SCCA RoadRally Rules glossary and sample GIs; see the research notes).
// The event's GIs win: their definitions replace these. Some letters mean different things at different
// rallies (BL, S), so those entries say so.
export const RALLY_GLOSSARY = {
  CAST: 'change average speed to (mph)', OM: 'official mileage', ODO: 'odometer', NRI: 'numbered route instruction',
  LRI: 'lettered route instruction', SI: 'special instruction', GI: 'general instructions', GIS: 'general instructions',
  TA: 'time allowance', TOD: 'time of day', TODR: 'time-of-day restart', PC: 'passage control', DIYC: 'do-it-yourself control',
  CP: 'checkpoint', OPP: 'opportunity: a road you could legally turn onto (dead ends, private roads and drives don\'t count)',
  OP: 'opportunity: a road you could legally turn onto', SAP: 'straight as possible', LAP: 'left as possible',
  RAP: 'right as possible', SO: 'straight on', SOL: 'sign on left', SOR: 'sign on right', RRX: 'railroad crossing',
  RXR: 'railroad crossing', XING: 'crossing', TL: 'traffic light', SS: 'stop sign', SL: 'speed-limit sign',
  FZ: 'free zone', TZ: 'transit zone', BFZ: 'begin free zone', EFZ: 'end free zone', BTZ: 'begin transit zone',
  ETZ: 'end transit zone', MR: 'main road', PR: 'principal road', MRD: 'main road determinant', CB: 'covered bridge',
  BL: 'bear left (some rallies use BL for a blinking light: check the GIs)', BR: 'bear right',
  B4: 'before', ITIS: 'if there is such: do it only if the sign or landmark turns up before the next instruction, otherwise skip it',
  SRIP: 'sign reading in part: the quoted words are only part of the sign', CZT: 'car zero time: add your car number in minutes',
  KT: 'key time', HTS: 'hard to see', DNE: 'does not exist', TC: 'time check (not scored)', CZ: 'change zone',
};
// Position words: the RoadRally Rules define BEFORE but not AFTER, and none of the others; each event's GIs decide.
const REL_TERMS = {
  after: ['AFTER', 'usually: the first chance once you have passed it (check this rally\'s GIs)'],
  before: ['BEFORE', 'the last chance before it, while it is in sight (check this rally\'s GIs)'],
  past: ['PAST', 'not defined in the national rules: check the GIs or ask at the drivers\' meeting'],
  opposite: ['OPPOSITE', 'not defined in the national rules: check the GIs or ask at the drivers\' meeting'],
};

const ROAD_WORDS = [
  [/\bRD\b/g, 'road'], [/\bST\b/g, 'street'], [/\bAVE?\b/g, 'avenue'], [/\bLN\b/g, 'lane'], [/\bDR\b/g, 'drive'],
  [/\bHWY\b/g, 'highway'], [/\bRT\b/g, 'route'], [/\bRTE\b/g, 'route'], [/\bSR\b/g, 'state route'], [/\bCR\b/g, 'county road'],
  [/\bTR\b/g, 'township road'], [/\bTWP\b/g, 'township'], [/\bPK(?:WY|Y)\b/g, 'parkway'], [/\bBLVD\b/g, 'boulevard'],
  [/\bCT\b/g, 'court'], [/\bPL\b/g, 'place'], [/\bTPKE\b/g, 'turnpike'], [/\bEXT\b/g, 'extension'],
  [/\bN\b/g, 'north'], [/\bS\b/g, 'south'], [/\bE\b/g, 'east'], [/\bW\b/g, 'west'], [/["“”]/g, ''],
];
const TEXT_WORDS = [
  [/\bBL\b/g, 'bear left'], [/\bBR\b/g, 'bear right'], [/\bL\b/g, 'left'], [/\bR\b/g, 'right'], [/\bS\b/g, 'straight'],
  [/\bSAP\b/g, 'straight as possible'], [/\bRRX\b/g, 'railroad crossing'], [/\bOPP\b/g, 'opportunity'], [/\bXING\b/g, 'crossing'],
  [/\bSOL\b/g, 'sign on left'], [/\bSOR\b/g, 'sign on right'], [/\bTL\b/g, 'traffic light'], ...ROAD_WORDS.filter(([re]) => !/\\b[NSEW]\\b/.test(re.source)),
];

const expand = (s, words) => {
  let x = ` ${String(s ?? '').toUpperCase()} `;
  for (const [re, w] of words) x = x.replace(re, w);
  return x.replace(/\s+/g, ' ').trim().toLowerCase();
};
// Spoken form of free text (abbreviations expanded) and of a road name (N/S/E/W read as compass points).
export const speakable = (text) => expand(text, TEXT_WORDS);
export const speakRoad = (name) => expand(name, ROAD_WORDS);

const ORD = (n) => (n % 100 >= 11 && n % 100 <= 13 ? `${n}th` : `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`);
const SPOKEN_ORD = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const sOrd = (n) => SPOKEN_ORD[n] ?? ORD(n);
const DIR = { L: ['Turn LEFT', 'left'], R: ['Turn RIGHT', 'right'], S: ['Go STRAIGHT', 'straight'], BL: ['BEAR LEFT', 'bear left'],
  BR: ['BEAR RIGHT', 'bear right'], U: ['Make a U-TURN', 'U-turn'] };
const LANDMARK = { RRX: 'railroad crossing', 'COVERED BRIDGE': 'covered bridge' };
const secs = (s) => (Math.abs(s - Math.round(s)) < 0.05 ? String(Math.round(s)) : s.toFixed(1));

// Where the action happens, relative to the cue. Returns display parts and the spoken phrase.
function where(ins) {
  const c = ins.count > 1 ? ins.count : null;
  const nth = c ? `${ORD(c)} ` : '', snth = c ? `${sOrd(c)} ` : '';
  const rel = ins.sign_rel || 'at';
  const relWords = { at: ['at the ', 'at the '], after: ['at the first chance after the ', 'after the '],
    before: ['at the last chance before the ', 'before the '], past: ['after passing the ', 'past the '],
    opposite: ['where the ', 'opposite the '] }[rel];
  switch (ins.cue) {
    case 'sign': {
      const q = ins.sign_text || '?';
      return { parts: [{ t: ` ${relWords[0]}${nth}sign ` }, { t: `“${q}”`, k: 'sign' }, { t: rel === 'opposite' ? ' is, across the road' : '' }],
        spoken: ` ${relWords[1]}${snth}sign reading ${speakable(q)}` };
    }
    case 'T': return { parts: [{ t: ` at the ${nth}T (the road ends)` }], spoken: ` at the ${snth}T` };
    case 'Y': return { parts: [{ t: ` at the ${nth}Y (the road forks)` }], spoken: ` at the ${snth}fork` };
    case 'stop': return { parts: [{ t: ` at the ${nth}STOP sign` }], spoken: ` at the ${snth}stop sign` };
    case 'yield': return { parts: [{ t: ` at the ${nth}YIELD sign` }], spoken: ` at the ${snth}yield sign` };
    case 'signal': return { parts: [{ t: ` at the ${nth}traffic light` }], spoken: ` at the ${snth}light` };
    case 'landmark': {
      if (/\(as possible\)$/.test(ins.landmark || '')) return { parts: [], spoken: '' };
      const lm = LANDMARK[ins.landmark] ?? String(ins.landmark || 'landmark').toLowerCase();
      return { parts: [{ t: ` ${relWords[0]}${nth}` }, { t: lm, k: 'landmark' }, { t: rel === 'opposite' ? ' is, across the road' : '' }],
        spoken: ` ${relWords[1]}${snth}${lm}` };
    }
    default: {
      if (!c) return { parts: [], spoken: '' };
      const d = DIR[ins.dir]?.[1] ?? '';
      const what = ins.dir === 'S' ? 'intersection' : `road you could turn ${d.replace('bear ', '')} onto`;
      return { parts: [{ t: ` at the ${nth}${what}` }], spoken: ` at the ${snth}opportunity` };
    }
  }
}

// Glossary hits in the printed text: abbreviations a stressed navigator may not know.
export function termsIn(text, glossary = RALLY_GLOSSARY) {
  const out = [];
  const seen = new Set();
  const up = ` ${String(text ?? '').toUpperCase().replace(/["“”(),.;:]/g, ' ')} `;
  for (const [term, meaning] of Object.entries(glossary)) {
    if (['BL', 'BR', 'CAST', 'T', 'SO', 'OP'].includes(term) || seen.has(term)) continue;
    const re = new RegExp(`\\s${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`);
    if (re.test(up)) { out.push({ term, meaning }); seen.add(term); }
  }
  return out.slice(0, 4);
}

// Returns {text, parts:[{t,k}], speech, warn, terms}. k marks emphasis: dir, sign, road, landmark, num.
export function explain(ins, { glossary = null } = {}) {
  const sentences = [];   // each: parts
  const speech = [];
  let warn = null;
  const gl = glossary ? { ...RALLY_GLOSSARY, ...glossary } : RALLY_GLOSSARY;

  if (ins.action === 'turn' && ins.dir && DIR[ins.dir]) {
    const asPossible = /^(SAP|LAP|RAP) \(as possible\)$/.exec(ins.landmark || '');
    const verb = asPossible ? { SAP: 'Go as STRAIGHT as possible', LAP: 'Go as far LEFT as possible', RAP: 'Go as far RIGHT as possible' }[asPossible[1]] : DIR[ins.dir][0];
    const s = [{ t: verb, k: 'dir' }];
    let spoken = asPossible ? { SAP: 'straight as possible', LAP: 'left as possible', RAP: 'right as possible' }[asPossible[1]] : DIR[ins.dir][1];
    const w = where(ins);
    s.push(...w.parts); spoken += w.spoken;
    if (ins.onto) {
      const surface = /^(UN)?PAVED$|^GRAVEL$|^DIRT$/i.exec(ins.onto);
      if (surface) { s.push({ t: ` onto the ${ins.onto.toLowerCase()} road` }); spoken += ` onto the ${ins.onto.toLowerCase()} road`; }
      else { s.push({ t: ' onto ' }, { t: ins.onto, k: 'road' }); spoken += ` onto ${speakRoad(ins.onto)}`; }
    }
    if (ins.sign_side) s.push({ t: ` (sign on your ${ins.sign_side === 'L' ? 'left' : 'right'})` });
    sentences.push(s); speech.push(spoken);
  } else if (ins.action === 'turn') {
    sentences.push([{ t: ins.text || 'Turn' }]); speech.push(speakable(ins.text));
  }

  if (ins.cast_mph > 0) {
    const s = [{ t: 'Average speed now ' }, { t: `${ins.cast_mph} mph`, k: 'num' }];
    if (ins.action !== 'turn' && ins.cue === 'sign' && ins.sign_text) s.push({ t: ' from the sign ' }, { t: `“${ins.sign_text}”`, k: 'sign' });
    else if (ins.action !== 'turn' && ins.cue === 'landmark' && ins.landmark) s.push({ t: ` from the ${LANDMARK[ins.landmark] ?? ins.landmark.toLowerCase()}` });
    sentences.push(s); speech.push(`cast ${ins.cast_mph}`);
  }
  if (ins.pause_s > 0) {
    const atStop = ['stop', 'T', 'yield', 'signal'].includes(ins.cue);
    sentences.push([{ t: 'Add ' }, { t: `${secs(ins.pause_s)} s`, k: 'num' }, { t: atStop ? ' — wait it out at the stop; the app counts down' : ' to your time (the app adds it)' }]);
    speech.push(`pause ${secs(ins.pause_s)} seconds`);
  }
  if (ins.gain_s > 0) {
    sentences.push([{ t: 'Take ' }, { t: `${secs(ins.gain_s)} s`, k: 'num' }, { t: ' off your time (the app takes it)' }]);
    speech.push(`gain ${secs(ins.gain_s)} seconds`);
  }
  const edge = ins.zone ? (ins.action === 'zone_start' ? 'start' : ins.action === 'zone_end' ? 'end' : ins.zone_edge) : null;
  if (edge) {
    const start = edge === 'start';
    const z = ins.zone === 'transit' ? 'Transit zone' : 'Free zone';
    const allow = ins.transit_s > 0 ? `${Math.floor(ins.transit_s / 60)}:${String(Math.round(ins.transit_s % 60)).padStart(2, '0')}` : null;
    const tail = ins.zone === 'transit' ? (start ? (allow ? `: no average speed; you have ${allow} to reach its end` : ': no average speed; reach the end by the given time') : ': average speed applies again')
      : (start ? ': no checkpoints until it ends; you may stop' : ': checkpoints possible again');
    sentences.push([{ t: `${z} ${start ? 'starts' : 'ends'}${tail}` }]); speech.push(`${z.toLowerCase()} ${start ? 'begins' : 'ends'}`);
  }
  if (ins.action === 'control') {
    const c = { open: ['Checkpoint: stop at the orange sign; you get an out time', 'checkpoint'],
      passage: ['Passage control: drive past without stopping', 'passage control'],
      diyc: ['Do-it-yourself control: write down your arrival time; leave exactly 2 minutes later', 'do it yourself control'],
      gps: ['GPS checkpoint (unmarked): just stay on time', 'GPS checkpoint'] }[ins.control] ?? ['Checkpoint', 'checkpoint'];
    sentences.push([{ t: c[0] }]); speech.push(c[1]);
  }
  const atSign = ins.action !== 'turn' && ins.cue === 'sign' && ins.sign_text ? [{ t: ' at the sign ' }, { t: `“${ins.sign_text}”`, k: 'sign' }] : [{ t: ' here' }];
  if (ins.odo_check_start) { sentences.push([{ t: 'Odometer check starts' }, ...atSign]); speech.push('odometer check starts'); }
  if (ins.odo_check_end) { sentences.push([{ t: 'Odometer check ends' }, ...atSign, { t: ': tap End odo check' }]); speech.push('end of odometer check'); }
  if (ins.reset_odo || ins.action === 'zero_odo') { sentences.push([{ t: 'Reset the trip odometer to ' }, { t: '0.00', k: 'num' }, { t: ' here' }]); speech.push('reset odometer'); }
  if (ins.restart_tod) {
    sentences.push([{ t: 'Leave at ' }, { t: ins.restart_tod, k: 'num' }, { t: ins.restart_plus_car ? ' plus your car number in minutes' : '' }]);
    speech.push(`restart at ${ins.restart_tod.replace(/:00$/, '')}`);
  }
  if (!sentences.length) { sentences.push([{ t: ins.text || '' }]); speech.push(speakable(ins.text)); }
  // A note that only repeats something explained above (odometer check, zone edges, the transit allowance) is dropped.
  const repeats = (n) => (/\bODO(?:METER)?\s+CHECK\b/i.test(n) && (ins.odo_check_start || ins.odo_check_end))
    || (/^\s*(?:BEGIN|BEGINS|START|END|ENDS)\b.*\bZONE\b/i.test(n) && edge) || (/^\s*ALLOW\b/i.test(n) && ins.zone === 'transit');
  if (ins.note && !repeats(ins.note)) { sentences.push([{ t: `Note: ${ins.note}` }]); if (ins.note.length <= 40) speech.push(speakable(ins.note)); }
  // ITIS (if there is such): optional; skipped when its sign or landmark doesn't turn up first.
  if (/\bITIS\b/i.test(ins.text || '')) { sentences.push([{ t: 'Only if it is there: if you reach the next instruction first, skip this one' }]); speech.push('only if it is there'); }

  const partial = /\bSRIP\b/i.test(ins.text || '');
  if (ins.cue === 'sign' && ins.sign_text) {
    warn = partial
      ? `“${ins.sign_text}” is part of a SIGN's wording (sign reading in part) — not the real thing and not a picture.`
      : `“${ins.sign_text}” in quotes means a SIGN showing these exact words side by side (case and punctuation don't matter) — not the real thing and not a picture.`;
  } else if (ins.cue === 'landmark' && ins.landmark && !LANDMARK[ins.landmark] && !/\(as possible\)$/.test(ins.landmark)) {
    warn = `${ins.landmark} without quotes means the real ${ins.landmark.toLowerCase()}, not a sign.`;
  }

  // The position word's meaning: the event's own definition if its GIs give one, else the usual one.
  const terms = termsIn(ins.text, gl);
  const rel = REL_TERMS[ins.sign_rel];
  if (rel && (ins.cue === 'sign' || ins.cue === 'landmark')) terms.unshift({ term: rel[0], meaning: glossary?.[rel[0]] ?? rel[1] });

  const parts = [];
  sentences.forEach((s, i) => { if (i) parts.push({ t: '. ' }); parts.push(...s.filter((p) => p.t)); });
  parts.push({ t: '.' });
  const text = parts.map((p) => p.t).join('').replace(/\s+/g, ' ').replace(/\.\./g, '.').trim();
  return { text, parts, speech: speech.filter(Boolean).join(', '), warn, terms: terms.slice(0, 4) };
}
