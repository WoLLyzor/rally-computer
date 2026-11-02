// The navigator's coach: what to do right now, in plain words, from the live state. A headline (what to
// tell the driver, or what to tap) and one line of speed and time advice.
// coach(state, { rows, startTod }) -> { title, text, tone: 'info' | 'watch' | 'good', act }
// act: the button that matters now ('start', 'richta', 'back') so the screen can point at it.
import { explain } from '../core/explain.js';
import { fmtTod } from '../core/instruction.js';

export function distWords(mi) {
  if (mi === null || mi === undefined || !Number.isFinite(mi)) return null;
  if (mi < 0.5) return `${Math.max(50, Math.round(mi * 1760 / 50) * 50)} yards`;
  return `${mi.toFixed(1)} miles`;
}
const mmss = (s) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const say = (ins) => (explain(ins).text || ins.text || '').replace(/\s+/g, ' ').trim().replace(/\.$/, '');
// Coming back the other way, the turn is on the other side.
const BACK = { L: 'turn RIGHT', R: 'turn LEFT', BL: 'bear RIGHT', BR: 'bear LEFT', S: 'go straight' };

// "Speed up to 44 (now 42). 4 s late." Close to a turn: "Slow down for the turn."
export function paceLine(st, { turnSoon = false } = {}) {
  const out = [];
  const tgt = st.target_mph != null ? Math.round(st.target_mph) : null, v = st.speed_mph != null ? Math.round(st.speed_mph) : null;
  if (turnSoon && v !== null && v >= 3) out.push('Slow down for the turn.');
  else if (tgt !== null) {
    if (v === null || v < 3) out.push(`Drive ${tgt} mph.`);
    else if (tgt - v >= 2) out.push(`Speed up to ${tgt} (now ${v}).`);
    else if (v - tgt >= 2) out.push(`Slow to ${tgt} (now ${v}).`);
    else out.push(`Hold ${tgt} mph.`);
  }
  if (st.delta_s != null) {
    const n = Math.round(Math.abs(st.delta_s));   // the same rounding as the big number
    out.push(n === 0 ? 'On time.' : `${n} s ${st.delta_s > 0 ? 'late' : 'early'}.`);
  }
  return out.join(' ');
}

export function coach(st, ctx = {}) {
  if (!st) return { title: 'Getting ready…', text: '', tone: 'info', act: null };
  const rowOf = (n) => (ctx.rows || []).find((r) => r.n === n) ?? null;

  if (!st.started) {
    const at = ctx.startTod ?? null, left = at === null ? null : at - st.t_s;
    if (left === null) return { title: 'Before the start', text: 'At the start line, tap START as you leave.', tone: 'info', act: 'start' };
    if (left > 60) return { title: `Start at ${fmtTod(at)} (in ${mmss(left)})`, text: 'Wait at the start line. When the clock reaches your start time, tap START, or RICHTA BEEPED if Richta beeps.', tone: 'info', act: 'start' };
    if (left > 0) return { title: `Start in ${Math.ceil(left)} s`, text: `Leave the start line at ${fmtTod(at)} and tap START.`, tone: 'watch', act: 'start' };
    return { title: 'Start now', text: left > -60 ? 'Leave the start line and tap START.' : `Your start time ${fmtTod(at)} has passed. Tap START as you leave the start line.`, tone: 'watch', act: 'start' };
  }

  const a = st.alert;
  if (a?.kind === 'missed_turn') {
    const r = rowOf(a.n), back = a.back_mi != null && a.back_mi > 0 ? distWords(a.back_mi) : null;
    const turn = r?.dir && BACK[r.dir] ? `${BACK[r.dir]}${r.onto ? ` onto ${r.onto}` : ''}` : 'turn onto the route';
    return { title: `Missed turn? #${a.n}`, tone: 'watch', act: 'back',
      text: `${r ? cap(say(r)) : 'The turn'}${back ? ` was ${back} back` : ''}. If you missed it: turn around when safe, drive back${back ? ` ${back}` : ''}, then ${turn}. Tap BACK ON ROUTE as you make that turn.` };
  }
  const mh = !a ? st.map_hint : null;
  if (mh?.kind === 'offroute') {
    return { title: 'Off the route?', tone: 'watch', act: 'back',
      text: `The map’s route guess (${mh.pct}% sure) goes along ${mh.routeRoad || 'another road'}${mh.road ? `; you’re on ${mh.road}` : ''}. Check the last instruction. If you turned wrong: turn around when safe, go back to ${mh.routeRoad || 'the pink line'}, and tap BACK ON ROUTE there.` };
  }
  if (a?.kind === 'offcourse') return { title: 'Off course', tone: 'watch', act: 'back', text: 'Go back the way you came (the green line on the map) to where you left the route. Tap BACK ON ROUTE when you’re there.' };
  if (a?.kind === 'recovering') return { title: 'The app was paused', tone: 'watch', act: null, text: 'It fixes the distance by itself at the next turn. To fix it now: tap the line you’re passing in the list, then WE’RE HERE.' };
  if (a?.kind === 'calibration') return { title: 'Odometer check looks wrong', tone: 'watch', act: null, text: 'If its end was set at the wrong place, tap UNDO.' };
  if (a?.kind === 'gps_lost') return { title: 'No GPS signal', tone: 'watch', act: null, text: 'Distance is being estimated. Check that the RaceBox is on and connected (top bar: Connect RaceBox).' };

  if (st.hold) {
    return st.hold.go ? { title: 'GO now', text: 'Pause done. Tell the driver to go.', tone: 'good', act: null }
      : { title: `Pause: leave in ${mmss(st.hold.in_s)}`, text: 'Stay stopped. The app counts down and says GO.', tone: 'info', act: null };
  }
  if (st.waiting) {
    const w = st.waiting, where = w.to_mi != null && w.to_mi > 0.02 ? ` The restart is in ${distWords(w.to_mi)}.` : '';
    if (w.tod != null) {
      return { title: w.in_s > 0 ? `Segment done. Restart in ${mmss(w.in_s)}` : 'Restart now', tone: w.in_s > 0 ? 'good' : 'watch', act: 'richta',
        text: `Leave the restart at ${fmtTod(w.tod)}. Tap RICHTA BEEPED when Richta beeps there; a few seconds late is OK.${where}` };
    }
    return { title: 'Segment done: no timing now', tone: 'good', act: 'richta',
      text: `${w.any === 'minute' ? 'You can stop. Next segment: leave the restart on any whole minute, crossing just after :00.' : 'You can stop. The next segment starts as you cross the restart.'} Tap RICHTA BEEPED when Richta beeps there; a few seconds late is OK.${where}` };
  }
  if (st.zone === 'transit') {
    return { title: 'Transit: no timing', text: `Only the timed zones count, so stop if you like. Tap RICHTA BEEPED when Richta beeps where the next one starts (#${st.transit_end_n}).`, tone: 'info', act: null };
  }

  const nx = st.next, ins = nx?.ins;
  if (!nx || !ins) return { title: 'No more instructions', text: 'After the finish: Home, then Log, then Save file.', tone: 'good', act: null };
  const pace = paceLine(st, { turnSoon: ins.action === 'turn' && nx.to_mi != null && nx.to_mi < 0.12 });
  if (!st.calibrated && ins.odo_check_end) {
    return { title: `Odometer check ends ${nx.to_mi != null ? `in ${distWords(Math.max(0, nx.to_mi))}` : 'ahead'}`, tone: 'watch', act: null,
      text: `As the front wheels reach it, tap its line in the list, then “At #${nx.n} now”: ${say(ins)}. ${pace}`.trim() };
  }
  if (nx.to_mi == null || ins.D == null) return { title: `Watch for: ${say(ins)}`, text: `As you pass it, tap its line in the list, then “At #${nx.n} now”. ${pace}`.trim(), tone: 'watch', act: null };
  const nxt = st.after?.[0]?.ins;
  const then = nxt && nxt.D != null && nxt.D - ins.D <= 0.2 ? ` Then right after: ${say(nxt)}.` : '';
  const late = st.delta_s != null && st.delta_s >= 20 && st.ta_suggest ? ' Held up by a train or traffic? Tap DELAY.' : '';
  return { title: `${nx.to_mi < 0.02 ? 'Now' : `In ${distWords(nx.to_mi)}`}: ${say(ins)}`, text: `${pace}${then}${late}`.trim(), tone: 'info', act: null };
}
