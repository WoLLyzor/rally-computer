// Rule-based rally-language parser (offline profile, §6.1; also cross-checks the cloud reader).
// Turns route-instruction lines like `23  7.42  R at T onto "SMITH RD". CAST 36` into §4 Instructions.

import { normalizeInstruction, blankInstruction } from './instruction.js';

const WORD_NUM = { FIRST: 1, SECOND: 2, THIRD: 3, FOURTH: 4, FIFTH: 5, SIXTH: 6, SEVENTH: 7, EIGHTH: 8, NINTH: 9, TENTH: 10 };
const QUOTE_CHARS = /[“”„″"]/g;   // curly and straight double quotes → "
const SQUOTE_CHARS = /[‘’′`]/g;

// OCR-tolerant numeric token: O→0, l/I→1, S→5 inside digit runs, comma decimal.
function cleanNumericToken(tok) {
  if (!/^[\dOoIlS,.\/]+$/.test(tok) || !/\d/.test(tok)) return tok;
  return tok.replace(/[Oo]/g, '0').replace(/[Il]/g, '1').replace(/S/g, '5').replace(',', '.');
}

// Split a raw line into {n, om, om_decimals, reset_odo, body}.
export function splitMargin(line) {
  let s = line.replace(/\t/g, ' ').trim();
  const out = { n: null, om: null, om_decimals: null, reset_odo: false, body: s };
  const toks = s.split(/\s+/);
  let i = 0;
  // Instruction number: "23", "23.", "23)", "#23".
  if (toks[i] !== undefined) {
    const t = cleanNumericToken(toks[i].replace(/^#/, ''));
    const m = t.match(/^(\d{1,3})[.)]?$/);
    if (m && !/^\d+\.\d+$/.test(t)) { out.n = +m[1]; i++; }
  }
  // Official mileage: "7.42", "07.42", "(7.42)", "7.42/0.00", "/0.00".
  if (toks[i] !== undefined) {
    const t = cleanNumericToken(toks[i].replace(/^\(|\)$/g, ''));
    let m = t.match(/^(\d{1,3}\.(\d{1,3}))(\/0?\.00?)?$/);
    if (m) {
      out.om = parseFloat(m[1]); out.om_decimals = m[2].length;
      if (m[3]) out.reset_odo = true;
      i++;
    } else if (/^\/0?\.00?$/.test(t)) {
      out.reset_odo = true; i++;
    }
    // A separate "/0.00" token right after the mileage.
    if (toks[i] !== undefined && /^\/0?\.00?$/.test(cleanNumericToken(toks[i]))) { out.reset_odo = true; i++; }
  }
  out.body = toks.slice(i).join(' ');
  // Trailing mileage column ("... ONTO SMITH RD    7.42").
  if (out.om === null) {
    const m = out.body.match(/\s(\d{1,3}\.(\d{2,3}))(\s*\/\s*0\.00)?\s*$/);
    if (m) {
      out.om = parseFloat(m[1]); out.om_decimals = m[2].length;
      if (m[3]) out.reset_odo = true;
      out.body = out.body.slice(0, m.index).trim();
    }
  }
  return out;
}

// Clauses split on ';' or a period that is not a decimal point.
function clauses(body) {
  return body.split(/;|(?<!\d)\.(?!\d)|\.(?=\s)|\s+-\s+/).map((c) => c.trim()).filter(Boolean);
}

function stripQuotes(s) {
  return s.replace(/^["']|["']$/g, '').trim();
}

const DIR_RE = /^(?:(?:THEN|AND)\s+)?(?:(?:TURN|GO|MAKE\s+A|CONTINUE|PROCEED)\s+)?(?:(HARD|SHARP|SLIGHT|BEAR|KEEP|VEER|STAY)\s+)?(LEFT|RIGHT|BL|BR|L|R|STRAIGHT|SAP|LAP|RAP|SO|S|U-?TURN|U|AROUND)(?=$|[\s\/@"',(])/;
const DIR_FOLLOW_OK = /^(?:$|\s*(?:\/|@|AT\b|ONTO\b|ON\b|INTO\b|TO\b|AFTER\b|BEFORE\b|B4\b|PAST\b|BEYOND\b|OPP(?:OSITE)?\b|THEN\b|AND\b|THRU\b|THROUGH\b|"|'|,|\(|\d(?:ST|ND|RD|TH)\b|FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH))/;
// A cue with its relation word: `at "BEAR"`, `after "SLOW"`, `B4 "ONE LANE BRIDGE"`, `opposite "BARN"`,
// `@ 2nd STOP`, `thru STOP`, `at SRIP "HUDSON"` (sign reading in part). Groups: 1 relation word, 2 "@",
// 3 OPP(osite) before a quote, 4/5 count, 6 the cue.
const CUE_RE = /(?:\b(AT|AFTER|BEFORE|B4|PAST|BEYOND|OPPOSITE|THRU|THROUGH)\s+|(@)\s*|\/|\b(OPP)\s+(?=["']))(?:THE\s+)?(?:SRIP\s+)?(?:(\d{1,2})(?:ST|ND|RD|TH)\s+|(FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH|NINTH|TENTH)\s+)?("[^"]+"|'[^']+'|T(?=\b)|Y(?=\b)|STOP(?:\s+SIGN)?|SS\b|(?:4|FOUR|ALL)-?\s?WAY(?:\s+STOP)?|YIELD(?:\s+SIGN)?|(?:TRAFFIC\s+|FLASHING\s+)?(?:SIGNAL|LIGHT)|TL\b|END(?:\s+OF\s+(?:THE\s+)?ROAD)?|RRX|RXR|RR\s+(?:TRACKS|XING|CROSSING)|RAILROAD\s+(?:TRACKS|CROSSING)|COVERED\s+BRIDGE|CB\b|BRIDGE|ROUNDABOUT|TRAFFIC\s+CIRCLE|OPP(?:ORTUNITY|ORTUNITIES)?|OP\b|INTERSECTION|ROAD|CHURCH|CEMETERY|SCHOOL|SL\s*\d{2}\b|SPEED\s+LIMIT(?:\s+SIGN)?\s*\d{2}\b)/;
const AT_NAME_RE = /^\s*(?:AT|@)\s+(?:THE\s+)?([A-Z][A-Z0-9 .'\-&#]*?)(?=\s*(?:$|,|\(|\bINTO\b|\bAND\b|\bTHEN\b|\bCAST\b|\bPAUSE\b|\bSO[LR]\b))/;
const REL_OF = { AT: 'at', '@': 'at', THRU: 'at', THROUGH: 'at', AFTER: 'after', PAST: 'past', BEYOND: 'past', BEFORE: 'before', B4: 'before', OPPOSITE: 'opposite', OPP: 'opposite' };
// "ONTO X" or "ON X" (not "ON LEFT"), ending at the next clause word, a parenthesis or a reset marker.
const ONTO_RE = /\b(?:ONTO|(?:TO\s+STAY\s+)?ON(?!\s+(?:THE\s+)?(?:LEFT|RIGHT)\b))\s+(?:THE\s+)?("[^"]+"|'[^']+'|[A-Z0-9][A-Z0-9 .'\-&\/#]*?)(?=\s*(?:$|,|\bAT\b|@|\bCAST\b|\bPAUSE\b|\bGAIN\b|\bTHEN\b|\bAND\b|\(|\bAFTER\b|\bBEFORE\b|\bPAST\b|\bOPPOSITE\b|\bSO[LR]\b|\bTO\s+FOLLOW\b|\bIGNORE\b|\/\s*0?\.00\b))/;
const CAST_RE = /\b(?:CAST|CAS|AVG|AVERAGE\s+SPEED|CHANGE\s+(?:AVERAGE|AVG\.?)\s+SPEED)(?:\s+TO)?\s*[:=]?\s*(\d{1,2}(?:\.\d)?)\b(?:\s*MPH)?/;
const PG_RE = /\b(PAUSE|GAIN)\s*[:=]?\s*(\d{1,2}:\d{2}|\d*\.\d+|\d+)\s*(MINUTES?|MINS?|M\b|SECONDS?|SECS?|S\b)?/;
// Zone edges, also as BFZ/EFZ (begin/end free zone) and BTZ/ETZ (transit). Group 3: F or T of the abbreviation.
const ZONE_START_RE = /\b(?:(?:BEGIN|BEGINS|START|STARTS|ENTER|ENTERING)\s+(?:A\s+|THE\s+)?(FREE|TRANSIT)(?:\s+ZONE)?|(FREE|TRANSIT)\s+ZONE\s+(?:BEGINS|STARTS|BEGIN|START)|B(F|T)Z)\b/;
const ZONE_END_RE = /\b(?:(?:END|ENDS|EXIT|LEAVE)\s+(?:OF\s+)?(?:THE\s+)?(FREE|TRANSIT)(?:\s+ZONE)?|(FREE|TRANSIT)\s+ZONE\s+(?:ENDS|END)|E(F|T)Z)\b/;
const CONTROL_RE = /\b(DIYC|DO[-\s]IT[-\s]YOURSELF(?:\s+CONTROL)?|GPS\s+CONTROL|PASSAGE\s+CONTROL|OPEN\s+CONTROL|CHECKPOINT|CHECK\s+POINT|TIME\s+CONTROL|CONTROL)\b/;
const RESET_RE = /(?:\/\s*0\.00\b|\b(?:RESET|ZERO|RE-?ZERO)\s+(?:YOUR\s+|THE\s+)?(?:ODO(?:METER)?|TRIP)\b|\bODO(?:METER)?\s+(?:RESET|TO\s+ZERO)\b)/;
const ODO_END_RE = /\b(?:END|ENDS)\s+(?:OF\s+)?(?:THE\s+)?ODO(?:METER)?\s*(?:CHECK|CAL(?:IBRATION)?)\b/;
// A restart whose time the crew chooses: at the top of any minute (Richta "restart at the top of any
// minute"), or flying (timing starts as the car crosses the line).
const RESTART_MINUTE_RE = /\b(?:RE)?START\b[^.;]*?\bTOP\s+OF\s+(?:ANY|A|THE|EACH|NEXT)?\s*MINUTE\b|\b(?:(?:RE)?START|LEAVE|DEPART|GO)\s+(?:AT|ON)\s+(?:THE\s+)?(?:TOP\s+OF\s+)?(?:ANY|A|THE\s+NEXT)\s+(?:WHOLE\s+|FULL\s+)?MINUTE\b/;
const RESTART_FLYING_RE = /\bFLYING\s+(?:RE)?START\b|\b(?:(?:RE)?START|LEAVE|GO)\s+WHEN\s+(?:YOU(?:'RE|\s+ARE)\s+)?READY\b/;
const TOD_RE = /\b(?:RESTART|LEAVE|DEPART|OUT\s+TIME|ARRIVE)\s+(?:AT\s+)?(\d{1,2}:\d{2}(?::\d{2}|\.\d{2})?)(\s*\+\s*(?:YOUR\s+)?CAR\s*(?:NO\.?|NUMBER|#)(?:\s*MINUTES?)?)?/;
const TRANSIT_ALLOW_RE = /\b(?:ALLOW|ALLOWED|TRANSIT\s+TIME)\s*(?:OF\s+)?(\d{1,2}:\d{2}|\d+(?:\.\d+)?)\s*(MINUTES?|MINS?|SECONDS?|SECS?)?/;
const NOTE_RE = /\b(CAUTION|NOTE|ONE\s+LANE|SLOW|DANGER|WATCH|NARROW|OBSERVE|ATTENTION)\b/;
const SIDE_RE = /\bSO([LR])\b|\bSIGN\s+(?:IS\s+)?ON\s+(?:THE\s+|YOUR\s+)?(LEFT|RIGHT)\b|(?<=["'])\s*ON\s+(?:THE\s+|YOUR\s+)?(LEFT|RIGHT)\b/;
const IGNORE_RE = /\bIGNORE\s+(?:THE\s+)?("[^"]+"|'[^']+'|[A-Z][A-Z .'-]{1,30}?)(?=\s*(?:$|[,;.]|\bSIGN\b))/;
const FOLLOW_RE = /\b(?:TO\s+)?FOLLOW\s+(?:THE\s+)?(PRINCIPAL|MAIN)\s+ROAD\b/;
// Words in parentheses that make them a remark, not a road name: "(USE TURN POCKET)", "(AT CITGO)".
const PAREN_NOT_NAME = /\b(USE|IGNORE|AT|IN|OF|THE|SIGN|ON|FIRST|SECOND|THIRD|AND|OR|NOT|DO|DON'?T|CAUTION|NOTE|WATCH|PULL|AHEAD|AFTER|BEFORE|NEAR|PAST|BY|LOCALLY|ALSO|SEE|MARKED|SLOW|NARROW|IS|ARE|HARD|TO|FOR|YOUR|CAR|VICINITY|VICINTITY)\b/;

// Remarks in parentheses: the sign's side, a road name for the turn, or a note for the crew.
function parentheticals(body) {
  const out = { side: null, names: [], notes: [] };
  const rest = body.replace(/\(([^()]*)\)/g, (m, inner) => {
    const t = inner.trim(), U = t.toUpperCase();
    const side = U.match(/^(?:SIGN\s+(?:IS\s+)?)?ON\s+(?:THE\s+|YOUR\s+)?(LEFT|RIGHT)$|^SO([LR])$/);
    if (side) { out.side = (side[1] || side[2])[0]; return ' '; }
    if (/^["']?[A-Z0-9][A-Z0-9 .'\-&\/#]{0,40}["']?$/i.test(t) && t.split(/\s+/).length <= 4 && !PAREN_NOT_NAME.test(U)) { out.names.push(t.replace(/^["']|["']$/g, '')); return ' '; }
    if (t) out.notes.push(t);
    return ' ';
  });
  return { ...out, rest };
}

// Words that carry no meaning of their own once the patterns above are removed.
const FILLER = new Set(['THE', 'AT', 'A', 'AN', 'THEN', 'AND', 'SIGN', 'ONTO', 'ON', 'TO', 'IN', 'OF', 'MPH', 'AHEAD', 'ROAD',
  'TURN', 'GO', 'BEAR', 'KEEP', 'BEGIN', 'END', 'ZONE', 'SPEED', 'AVERAGE', 'CHANGE', 'YOUR', 'CAR', 'NUMBER', 'NO', 'MINUTES',
  'MIN', 'SEC', 'SECONDS', 'LIMIT', 'POSTED', 'NEAR', 'EDGE', 'IMMEDIATE', 'IMMEDIATELY', 'AFTER', 'BEFORE', 'INTO', '@', '-', '/',
  'STAY', 'PAST', 'BEYOND', 'OPPOSITE', 'CONTINUE', 'PROCEED', 'HERE', 'THIS', 'POINT', 'ODOMETER', 'CHECK', 'OF', 'ITIS', 'SRIP', 'B4']);

export function parsePauseAmount(num, unit) {
  let seconds, ambiguous = false;
  if (/^\d{1,2}:\d{2}$/.test(num)) {
    const [m, s] = num.split(':').map(Number);
    seconds = m * 60 + s;
  } else if (unit && /^S/.test(unit)) {
    seconds = parseFloat(num);
  } else if (unit && /^M/.test(unit)) {
    seconds = parseFloat(num) * 60;
  } else if (num.includes('.')) {
    seconds = parseFloat(num) * 60;            // rally convention: decimal minutes, PAUSE 0.20 = 12 s
  } else {
    seconds = parseFloat(num) * 60; ambiguous = true;   // bare integer: assume minutes, ask a human
  }
  return { seconds: Math.round(seconds * 1000) / 1000, ambiguous };
}

function dirFrom(mod, word) {
  const bear = mod && /BEAR|KEEP|VEER|SLIGHT|STAY/.test(mod);
  if (word === 'AROUND') return 'U';
  switch (word) {
    case 'LEFT': case 'L': return bear ? 'BL' : 'L';
    case 'RIGHT': case 'R': return bear ? 'BR' : 'R';
    case 'BL': return 'BL';
    case 'BR': return 'BR';
    case 'LAP': return 'L';
    case 'RAP': return 'R';
    case 'STRAIGHT': case 'S': case 'SO': case 'SAP': return 'S';
    default: return /^U/.test(word) ? 'U' : null;
  }
}

function cueFrom(tok) {
  if (/^["']/.test(tok)) return { cue: 'sign', sign_text: stripQuotes(tok) };
  const sl = tok.match(/^(?:SL|SPEED\s+LIMIT(?:\s+SIGN)?)\s*(\d{2})$/);
  if (sl) return { cue: 'sign', sign_text: `SPEED LIMIT ${sl[1]}` };
  if (tok === 'T' || /^END/.test(tok)) return { cue: 'T' };
  if (tok === 'Y') return { cue: 'Y' };
  if (/^STOP|WAY|^SS$/.test(tok)) return { cue: 'stop' };
  if (/^YIELD/.test(tok)) return { cue: 'yield' };
  if (/SIGNAL|LIGHT|^TL$/.test(tok)) return { cue: 'signal' };
  if (/^RR|^RXR|^RAILROAD/.test(tok)) return { cue: 'landmark', landmark: 'RRX' };
  if (/^COVERED|^CB$/.test(tok)) return { cue: 'landmark', landmark: 'COVERED BRIDGE' };
  if (/^ROUNDABOUT|CIRCLE$/.test(tok)) return { cue: 'landmark', landmark: 'ROUNDABOUT' };
  if (/^OPP|^OP$|^INTERSECTION|^ROAD/.test(tok)) return { cue: null };
  return { cue: 'landmark', landmark: tok };
}

// The first cue in a string, with its relation word and count.
function cueIn(str) {
  const m = str.match(CUE_RE);
  if (!m) return null;
  const c = cueFrom(m[6]);
  const rel = REL_OF[m[1] ?? (m[2] ? '@' : m[3] ? 'OPP' : 'AT')] ?? 'at';
  return { m, ...c, rel: c.cue === 'sign' || c.cue === 'landmark' ? rel : null, count: m[4] ? +m[4] : m[5] ? WORD_NUM[m[5]] : null };
}
function applyCue(r, c, { keepCue = false } = {}) {
  if (!keepCue || !r.cue) r.cue = c.cue;
  if (c.sign_text) r.sign_text = c.sign_text;
  if (c.landmark) r.landmark = c.landmark;
  if (c.rel) r.sign_rel = c.rel;
}

// Parse one instruction's body text (no margin). Returns a partial Instruction plus `unknown` tokens.
export function parseBody(bodyRaw) {
  const paren = parentheticals(bodyRaw.replace(QUOTE_CHARS, '"').replace(SQUOTE_CHARS, "'"));
  const body = paren.rest;
  const up = body.toUpperCase();
  const r = { action: 'note', dir: null, cue: null, onto: null, sign_text: null, landmark: null, count: null,
    cast_mph: null, pause_s: 0, gain_s: 0, zone: null, control: null, reset_odo: false, odo_check_end: false,
    restart_tod: null, restart_plus_car: false, restart_any: null, transit_s: null, sign_rel: null, sign_side: paren.side, note: null,
    pause_text: null, zone_edge: null };
  const notes = [...paren.notes];
  let penalty = 0;
  let consumed = up;
  const eat = (m) => { if (m) consumed = consumed.replace(m[0], ' '); };

  const found = { turn: false, cast: false, pause: false, gain: false, zs: false, ze: false, control: false, reset: false };

  // Remarks outside parentheses: sign side (SOL/SOR, `"X" ON LEFT`), signs to ignore, "follow the principal road".
  const side = up.match(SIDE_RE);
  if (side) { r.sign_side = (side[1] || side[2] || side[3])[0]; eat(side); }
  const ign = up.match(IGNORE_RE);
  if (ign) { notes.push(`IGNORE ${ign[1]}`); eat(ign); }
  const fol = up.match(FOLLOW_RE);
  if (fol) { notes.push(`follow the ${fol[1].toLowerCase()} road`); eat(fol); }
  const scan = consumed;   // the text the clause patterns read, remarks removed

  for (const clause of clauses(scan)) {
    const dm = clause.match(DIR_RE);
    if (dm && !r.dir) {
      const rest = clause.slice(dm[0].length);
      const strong = DIR_FOLLOW_OK.test(rest) || ['LEFT', 'RIGHT', 'BL', 'BR', 'STRAIGHT', 'SAP', 'LAP', 'RAP', 'AROUND'].includes(dm[2]) || /^U/.test(dm[2]);
      if (strong) {
        r.dir = dirFrom(dm[1], dm[2]); found.turn = true; eat(dm);
        if (['LAP', 'RAP', 'SAP'].includes(dm[2])) r.landmark = r.landmark || `${dm[2]} (as possible)`;
        const c = cueIn(rest);
        if (c) { applyCue(r, c); if (c.count) r.count = c.count; eat(c.m); }
        const om = rest.match(ONTO_RE);
        if (om) { r.onto = stripQuotes(om[1]).replace(/\s+/g, ' ').trim(); eat(om); }
        // `RIGHT AT STONEHILL`, `RIGHT AT BEACH ST INTO PARKING LOT`: an unquoted name after AT is the road.
        const an = !r.cue && !r.onto && !r.count ? rest.match(AT_NAME_RE) : null;
        if (an && !PAREN_NOT_NAME.test(an[1]) && !NOTE_RE.test(an[1])) { r.onto = an[1].replace(/\s+/g, ' ').trim(); eat(an); }
      }
    }
  }
  // A road name in parentheses names the road turned onto: `LEFT AT SECOND TRAFFIC LIGHT (HARRISON)`.
  if (found.turn && !r.onto && paren.names.length) r.onto = paren.names.shift().toUpperCase();
  notes.push(...paren.names);

  const cm = scan.match(CAST_RE);
  if (!cm && /\bCAST\b/.test(scan)) { found.cast = true; penalty += 0.4; }   // CAST with the speed unreadable: the checks flag it
  if (cm) {
    r.cast_mph = parseFloat(cm[1]); found.cast = true; eat(cm);
    if (!found.turn) {
      const c = cueIn(scan.slice(cm.index + cm[0].length));
      if (c) { applyCue(r, c); eat(c.m); }
    }
  }

  const pgAll = [...scan.matchAll(new RegExp(PG_RE.source, 'g'))];
  for (const pm of pgAll) {
    const { seconds, ambiguous } = parsePauseAmount(pm[2], pm[3]);
    if (ambiguous) penalty += 0.35;
    if (pm[1] === 'PAUSE') { r.pause_s += seconds; found.pause = true; r.pause_text = `${pm[2]}${pm[3] ? ' ' + pm[3] : ''}`; } else { r.gain_s += seconds; found.gain = true; }
    eat(pm);
    if (!found.turn && !found.cast) {
      const c = cueIn(scan.slice(pm.index + pm[0].length));
      if (c) { applyCue(r, c, { keepCue: true }); eat(c.m); }
    }
  }
  if (/\bEACH\b|\bEVERY\b/.test(scan) && (found.pause || found.gain)) penalty += 0.4;   // repeated pauses need a human

  const zs = scan.match(ZONE_START_RE);
  const ze = scan.match(ZONE_END_RE);
  const zoneOf = (m) => (m[1] || m[2] || (m[3] === 'F' ? 'FREE' : 'TRANSIT')).toLowerCase();
  if (zs) { r.zone = zoneOf(zs); found.zs = true; r.zone_edge = 'start'; eat(zs); }
  if (ze) { r.zone = r.zone || zoneOf(ze); found.ze = true; r.zone_edge = r.zone_edge || 'end'; eat(ze); }

  const ctl = up.match(CONTROL_RE);
  if (ctl) {
    const w = ctl[1];
    r.control = /DIYC|YOURSELF/.test(w) ? 'diyc' : /GPS/.test(w) ? 'gps' : /PASSAGE/.test(w) ? 'passage' : 'open';
    found.control = true; eat(ctl);
  }

  const rs = up.match(RESET_RE);
  if (rs) { r.reset_odo = true; found.reset = true; eat(rs); }
  const oe = up.match(ODO_END_RE);
  if (oe) { r.odo_check_end = true; eat(oe); }
  const ob = up.match(/\b(?:BEGIN|BEGINS|START)\s+(?:OF\s+)?(?:THE\s+)?ODO(?:METER)?\s*(?:CHECK|CAL(?:IBRATION)?)\b/);
  if (ob) { r.odo_check_start = true; eat(ob); }

  const tod = up.match(TOD_RE);
  if (tod) {
    const t = tod[1];
    r.restart_tod = /^\d{1,2}:\d{2}$/.test(t) ? `${t.padStart(5, '0')}:00` : t;
    r.restart_plus_car = !!tod[2];
    eat(tod);
  } else {
    const rm = up.match(RESTART_MINUTE_RE), rf = rm ? null : up.match(RESTART_FLYING_RE);
    if (rm || rf) { r.restart_any = rm ? 'minute' : 'flying'; eat(rm || rf); }
  }
  const ta = up.match(TRANSIT_ALLOW_RE);
  if (ta && (r.zone === 'transit' || /TRANSIT/.test(up))) {
    const { seconds } = parsePauseAmount(ta[1], ta[2]);
    r.transit_s = seconds; eat(ta);
  }

  // Primary action, by precedence.
  if (found.turn) r.action = 'turn';
  else if (found.control) r.action = 'control';
  else if (found.zs) r.action = 'zone_start';
  else if (found.ze) r.action = 'zone_end';
  else if (found.pause) r.action = 'pause';
  else if (found.gain) r.action = 'gain';
  else if (found.cast) r.action = 'cast';
  else if (found.reset) r.action = 'zero_odo';
  else r.action = 'note';
  // A zone that both ends and starts in one line ("End free zone. Begin transit zone") keeps the start.
  if (found.zs && found.ze && !found.turn && !found.control) r.action = 'zone_start';

  // A sign or landmark that locates something other than a turn: `Begin ODOMETER CHECK at "STOP AHEAD"`.
  if (!r.cue && !found.turn && r.action !== 'note') {
    const c = cueIn(consumed);
    if (c && (c.cue === 'sign' || c.cue === 'landmark')) { applyCue(r, c); eat(c.m); }
  }
  if (!r.cue && (r.odo_check_start || r.odo_check_end)) {
    const c = cueIn(consumed);
    if (c && (c.cue === 'sign' || c.cue === 'landmark')) { applyCue(r, c); eat(c.m); }
  }
  if (notes.length) r.note = notes.join('; ');

  // Confidence from leftover words.
  const leftovers = consumed.replace(/["'(),.;:]/g, ' ').split(/\s+/).filter((w) => w && !FILLER.has(w) && !/^\d+(\.\d+)?$/.test(w));
  const noteLike = NOTE_RE.test(up) || (r.action === 'note' && (notes.length > 0 || r.odo_check_start || r.odo_check_end || r.restart_tod || r.restart_any));
  if (r.action === 'note' && !noteLike) penalty += 0.45;
  if (r.action === 'note' && noteLike) penalty += 0.1;
  if (r.action !== 'note') penalty += Math.min(0.4, 0.06 * leftovers.length);
  if (r.action === 'turn' && !r.cue && !r.onto && !r.count && !r.landmark) penalty += 0.1;
  r.confidence = Math.max(0.2, Math.round((1 - penalty) * 100) / 100);
  r.unknown = leftovers;
  return r;
}

export function parseLine(line, { prevN = null } = {}) {
  const m = splitMargin(line);
  const b = parseBody(m.body);
  const ins = blankInstruction(m.n ?? (prevN !== null ? prevN + 1 : null));
  Object.assign(ins, b);
  delete ins.unknown;
  ins.text = m.body.trim();
  ins.om = m.om; ins.om_decimals = m.om_decimals;
  ins.reset_odo = m.reset_odo || b.reset_odo;
  if (m.n === null) ins.confidence = Math.min(ins.confidence, 0.5);
  if (ins.action === 'note' && ins.reset_odo) { ins.action = 'zero_odo'; ins.confidence = Math.max(ins.confidence, 0.9); }
  return normalizeInstruction(ins);
}

const HEADER_RE = /^\s*(?:NO\.?|#|NUM|INST|INSTRUCTION|OM|MILEAGE|MILES|ROUTE\s+INSTRUCTIONS?)\b/i;

// Lettered or special instructions that stand for the whole rally (or a stretch of it), outside the
// numbered sequence: `A. Turn left at each "FOX"`, `SI 2: CAST 30 at every "SCHOOL"`. Letters that are
// directions or intersections (L R S U T Y) and compass points are not labels.
const STANDING_RE = /^\s*(?:([A-HJKMPQVXZ])[.)]|S\.?I\.?\s*-?\s*(\d{1,2})[.:)]?|SPECIAL\s+INSTRUCTION\s+(\d{1,2})[.:)]?)\s+(\S.*)$/i;

// Parse a block of text (pasted or OCR'd). Lines that don't start a new numbered row continue the
// previous one. Standing (lettered/special) instructions are returned on the array as `.standing`.
export function parseText(text) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  const rows = [];
  const standing = [];
  let cur = null;
  for (const line of lines) {
    if (HEADER_RE.test(line) && !/\d+\.\d{2}/.test(line)) continue;
    const m = splitMargin(line);
    const startsRow = m.n !== null || (m.om !== null && /^\s*\(?\d/.test(line));
    const st = !startsRow ? line.match(STANDING_RE) : null;
    if (st) {
      cur = { standing: true, label: (st[1] || `SI ${st[2] || st[3]}`).toUpperCase(), text: st[4].trim() };
      standing.push(cur);
    } else if (startsRow || !cur) {
      cur = { raw: line };
      rows.push(cur);
    } else if (cur.standing) {
      cur.text += ' ' + line.trim();
    } else {
      cur.raw += ' ' + line.trim();
    }
  }
  const out = [];
  let prevN = null;
  for (const r of rows) {
    const ins = parseLine(r.raw, { prevN });
    out.push(ins);
    prevN = ins.n;
  }
  out.standing = standing.map(({ label, text: t }) => ({ label, text: t }));
  return out;
}

// Re-parse a single row's text after the driver edits it, keeping n/section/src/verified.
export function reparse(ins, newText) {
  const p = parseLine(newText, { prevN: ins.n - 1 });
  return { ...p, n: p.n ?? ins.n, section: ins.section, src: ins.src, verified: false, review: [] };
}
