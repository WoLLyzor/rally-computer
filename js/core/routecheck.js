// Claude settles the turns the map doesn't (core/routelock.js flags them): it reads the instructions around the
// turn and the rally's rules, looks at the roads at each junction that could be the turn and what follows each
// (tools on the road graph), and picks one, or says it can't tell. Sends the instructions to the cloud: only
// with the rallymaster's written OK, as for cloud reading.

import { branches, walk, traverse, out, arrive } from './routeproj.js';
import { roadKeys } from './mapview.js';

const norm = (a) => ((a % 360) + 540) % 360 - 180;

export const CHECK_TOOLS = [
  { name: 'roads_at', strict: true,
    description: 'Every road meeting at one of the candidate junctions: names, road class, and the angle you would turn onto it from the way the route arrives there (+ right, - left, 0 straight on). Use it to judge "at T", "at Y", "onto", signs and counted opportunities.',
    input_schema: { type: 'object', properties: { choice: { type: 'string', description: 'A candidate id such as "a".' } }, required: ['choice'], additionalProperties: false } },
  { name: 'ahead', strict: true,
    description: 'Drive on from a candidate junction along the road that choice turns onto, keeping to the main road, for some metres: the junctions passed (metres from the candidate, the roads there and their angles). Use it to see whether the next instructions fit after that choice.',
    input_schema: { type: 'object', properties: { choice: { type: 'string' }, metres: { type: 'integer', description: 'How far to look, 100 to 3000.' } }, required: ['choice', 'metres'], additionalProperties: false } },
  { name: 'decide', strict: true,
    description: 'Your answer for this turn, once. choice: the candidate id, or "unsure" when the words and the map do not settle it. reason: one or two plain sentences citing the instruction words and what the map shows.',
    input_schema: { type: 'object', properties: { choice: { type: 'string' }, reason: { type: 'string' } }, required: ['choice', 'reason'], additionalProperties: false } },
];

const CLASS = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service', 'track'];

// The map tools for one flagged turn. g: the road graph; choices: the turn's candidates ({ id, lat, lon, road,
// angle }); prev: { lat, lon } of the turn before (where the route arrives from).
export function mapTools(g, choices, prev) {
  const map = g.map, P0 = prev ? map.toLocal(prev.lat, prev.lon) : null;
  const vertexAt = (lat, lon) => {
    const [x, y] = map.toLocal(lat, lon);
    let best = -1, bd = Infinity;
    for (let v = 0; v < g.vx.length; v++) { const d = Math.hypot(g.vx[v] - x, g.vy[v] - y); if (d < bd) { bd = d; best = v; } }
    return bd <= 30 ? best : -1;
  };
  // The road arriving at v from the turn before: the one whose far end lies nearest it (a straight-on road
  // if there's no turn before).
  const arrival = (v) => {
    let best = null;
    for (let p = g.start[v]; p < g.start[v + 1]; p++) {
      const r = g.hRoad[p], f = g.hFwd[p] === 1, far = f ? g.rb[r] : g.ra[r];
      const d = P0 ? Math.hypot(g.vx[far] - P0[0], g.vy[far] - P0[1]) : 0;
      if (!best || d < best.d) best = { road: r, fwd: !f, d };   // arriving along r toward v
    }
    return best ? { road: best.road, fwd: best.fwd, hin: arrive(g, best.road, best.fwd) } : null;
  };
  const describe = (b) => ({ name: map.roads[b.road].name || '(no name)', other_names: map.roads[b.road].alts, class: CLASS[map.roads[b.road].c] ?? 'road', angle: Math.round(b.a) });
  const byId = new Map(choices.map((c) => [c.id, c]));
  return {
    roads_at({ choice }) {
      const c = byId.get(choice), v = c ? vertexAt(c.lat, c.lon) : -1;
      if (v < 0) return { error: `no junction for "${choice}"` };
      const a = arrival(v);
      return { choice, arriving_on: a ? map.roads[a.road].name || '(no name)' : null, roads: a ? branches(g, v, a.road, a.fwd, a.hin).map(describe) : [] };
    },
    ahead({ choice, metres }) {
      const c = byId.get(choice), v = c ? vertexAt(c.lat, c.lon) : -1;
      if (v < 0) return { error: `no junction for "${choice}"` };
      const a = arrival(v), bs = a ? branches(g, v, a.road, a.fwd, a.hin) : [];
      const b = bs.sort((p, q) => Math.abs(norm(p.a - c.angle)) - Math.abs(norm(q.a - c.angle)))[0];
      if (!b) return { error: 'no road leaves that junction that way' };
      const P = { pts: [[g.vx[v], g.vy[v]]], cum: [0] };
      const cur = traverse(g, P, b.road, b.fwd, roadKeys(map.roads[b.road]));
      const steps = walk(g, P, cur, Math.max(100, Math.min(3000, metres)));
      return { choice, onto: map.roads[b.road].name || '(no name)', passed: steps.map((st) => ({ metres: Math.round(st.s), roads: branches(g, st.v, st.road, st.fwd, st.hin).map(describe) })).filter((x) => x.roads.length > 1) };
    },
  };
}

// The question for one flagged turn: the lines around it, the rally's rules, the candidates.
export function checkPrompt({ flag, rows, digest }) {
  const i = rows.findIndex((r) => r.n === flag.n), around = rows.slice(Math.max(0, i - 3), i + 4);
  const fmt = (r) => `#${r.n}${r.om != null ? ` (OM ${Number(r.om).toFixed(2)})` : ''}: ${r.text ?? ''}`;
  const rules = [...(digest?.rules || []).map((x) => `- ${x.topic ? `${x.topic}: ` : ''}${x.rule ?? x.text ?? x}`), ...(digest?.special_instructions || []).map((x) => `- ${x.label ? `${x.label}: ` : ''}${x.text ?? x}`)];
  return [
    'A road rally route (SCCA time-speed-distance) has been laid on the road map. At this turn the map left more than one possible junction, or none fitted well. Decide which candidate is the instruction\'s turn.',
    '', 'The instructions around it (OM = official mileage, from the last odometer reset):', ...around.map(fmt),
    '', `The turn to settle: #${flag.n} (${flag.why}).`,
    'Candidates (metres_off: how far the junction is from where the instruction\'s mileage puts it; angle: + right, - left):',
    ...flag.choices.map((c) => `- ${c.id}: onto ${c.road ?? '(no name)'}, angle ${c.angle}, metres_off ${c.err_m}, map fit ${c.score}${c.chosen ? ' (the app\'s pick)' : ''}`),
    ...(rules.length ? ['', 'This rally\'s general instructions (they win over common practice):', ...rules] : []),
    '', 'Use roads_at and ahead to look at the candidates, then call decide once. Choose "unsure" rather than guess.',
  ].join('\n');
}

// Ask Claude about one flagged turn. client: an Anthropic client (messages.create). Returns { choice, reason }.
export async function checkTurn(client, { flag, rows, digest, tools, model = 'claude-opus-5-5', maxRounds = 8 }) {
  const messages = [{ role: 'user', content: checkPrompt({ flag, rows, digest }) }];
  for (let round = 0; round < maxRounds; round++) {
    const res = await client.messages.create({ model, max_tokens: 8000, thinking: { type: 'adaptive' }, tools: CHECK_TOOLS, messages });
    if (res.stop_reason === 'refusal') return { choice: 'unsure', reason: 'Claude declined to answer.' };
    const uses = res.content.filter((b) => b.type === 'tool_use');
    const decided = uses.find((u) => u.name === 'decide');
    if (decided) return { choice: String(decided.input.choice), reason: String(decided.input.reason) };
    if (!uses.length) { messages.push({ role: 'assistant', content: res.content }, { role: 'user', content: 'Please call decide with your answer.' }); continue; }
    messages.push({ role: 'assistant', content: res.content });
    messages.push({ role: 'user', content: uses.map((u) => {
      const fn = tools[u.name];
      let out;
      try { out = fn ? fn(u.input) : { error: `unknown tool ${u.name}` }; } catch (e) { out = { error: String(e.message || e) }; }
      return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out), ...(out?.error ? { is_error: true } : {}) };
    }) });
  }
  return { choice: 'unsure', reason: 'No answer after several rounds.' };
}
