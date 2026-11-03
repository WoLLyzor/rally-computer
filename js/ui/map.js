// Map view for the Drive screen: the offline road map around the car, turning with the car (heading up)
// and zooming by itself so the next instruction fits, with the track driven so far, covered bridges and
// road names. The road the next instruction turns onto is drawn in blue. + and − bias the zoom.
// mountMap(container) -> { update(state, live), destroy() }
import { h } from './dom.js';
import { decodeMap, roadKey, roadKeys, nearestRoad } from '../core/mapview.js';
import { store } from '../app/store.js';

let MAP = null, GRAPH = null, projectRoute = null, LOADING = null;   // decoded once, shared by every mount
// The map in use: the downloaded rally area (app/osmarea.js, store 'area') when one is set and on the tablet,
// else the built-in Ashtabula–Erie map.
export function loadMap(url = 'map/roads.json') {
  LOADING ??= (async () => {
    const area = store.get('area', null);
    let doc = null;
    if (area?.tiles?.length) { try { const { areaDoc } = await import('../app/osmarea.js'); doc = await areaDoc(area.tiles); } catch (e) { console.warn('area map', e); } }
    if (!doc) { const r = await fetch(url); if (!r.ok) throw new Error(`map ${r.status}`); doc = await r.json(); }
    MAP = decodeMap(doc);
    // The route guess loads on its own: if it fails, the map (and the app) work without it.
    try { const rp = await import('../core/routeproj.js'); GRAPH = rp.buildGraph(MAP); projectRoute = rp.projectRoute; } catch (e) { console.warn('route guess off', e); }
    return MAP;
  })().catch((err) => { LOADING = null; throw err; });
  return LOADING;
}
// A new area was downloaded or cleared: the next use loads the map again.
export function resetMap() { LOADING = null; MAP = null; GRAPH = null; }
// The offline map and its road graph (null graph if the route guess couldn't load), for the route lock.
export async function mapGraph() { await loadMap(); return { map: MAP, graph: GRAPH }; }

const WIDTH = [7, 6.5, 6, 5.5, 5, 4, 4, 2.2, 1.6];   // line width by road class: motorway … track
const INK = { bg: '#0e1217', major: '#8b97a4', road: '#5f6a76', minor: '#434b55', label: '#c9d1d9', onto: '#7cc4ff', track: '#3ddc84', bridge: '#f5b942', trail: '#9aa4ae' };

function halo(ctx, s, x, y, color, align = 'center', px = 15) {
  ctx.font = `700 ${px}px system-ui, sans-serif`; ctx.textAlign = align; ctx.textBaseline = 'middle';
  ctx.lineWidth = 4; ctx.strokeStyle = INK.bg; ctx.strokeText(s, x, y);
  ctx.fillStyle = color; ctx.fillText(s, x, y);
}

export function mountMap(container) {
  const canvas = h('canvas', { class: 'mp-canvas' });
  const status = h('div', { class: 'mp-status' }, 'Loading the map…');
  const road = h('div', { class: 'mp-road' });
  const speed = h('div', { class: 'mp-speed' });
  const btn = (label, aria, fn) => h('button', { class: 'mp-btn', 'aria-label': aria, onclick: fn }, label);
  const guess = h('div', { class: 'mp-guess', hidden: true });
  const root = h('div', { class: 'mp-root' }, canvas, speed, guess,
    h('div', { class: 'mp-tools' }, btn('+', 'Zoom in', () => zoom(0.7)), btn('−', 'Zoom out', () => zoom(1.45))),
    road, status, h('div', { class: 'mp-attr' }, '© OpenStreetMap contributors'));
  container.append(root);
  // bias: the crew's zoom on top of the automatic one; rot: the drawn heading, eased toward the car's.
  let bias = 1, mpp = null, last = null, drawnAt = 0, heading = null, rot = null, proj = null, projAt = 0, headingSavedAt = 0, lockXY = null;
  // Smooth on screen: the drawn centre glides toward the car (predicted between fixes along its heading), and
  // the turn and the zoom ease in over a fraction of a second; about 20 frames a second while shown.
  let ren = null, frameAt = null, raf = 0, alive = true, trackXY = { src: null, n: 0, xy: [] };
  // The driver's view at all times: the last course is kept while stopped, even across a restart of the app.
  try { const hs = localStorage.getItem('rc.mapHeading'); if (hs !== null && Number.isFinite(Number(hs))) heading = Number(hs); } catch { /* no storage */ }

  // Wrong turn? When a confident route guess (85%+ to the next turn) goes one way and the car clearly another
  // for 6 s while moving, the navigator is asked (never told): live.mapHint, shown by the coach line, with
  // the engine distance where the car left the line so BACK ON ROUTE can take the extra miles off.
  let good = null, offSince = null;
  const distToPath = (path, x, y) => {
    let best = Infinity;
    for (let j = 0; j + 1 < path.length; j++) {
      const [ax, ay] = path[j], [bx, by] = path[j + 1], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
      best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
    }
    return best;
  };
  function checkOffRoute(x, y, v, now, st, live) {
    const pct = proj ? Math.round(100 * (proj.turns?.[0]?.path_conf ?? proj.turns?.[0]?.conf ?? proj.conf)) : 0;
    const hint = live.mapHint;
    if (hint && (st.next?.n !== hint.nextN || now - hint.at > 45000)) live.mapHint = null;   // the app moved on, or it's stale
    if (!good) { if (proj && pct >= 85) good = { path: proj.path, pct, road: proj.road, nextN: st.next?.n }; return; }
    const d = distToPath(good.path, x, y);
    if (d <= 25) {
      offSince = null;
      if (live.mapHint?.kind === 'offroute') live.mapHint = null;
      good.sOn = live.engine?.s ?? null;
      if (proj && pct >= 85) Object.assign(good, { path: proj.path, pct, road: proj.road, nextN: st.next?.n });
      else if (st.next?.n !== good.nextN) good = null;
    } else if (d > 50 && v > 4) {
      offSince ??= now;
      if (now - offSince > 6000 && !live.mapHint) {
        const near = nearestRoad(MAP, x, y, heading);
        live.mapHint = { kind: 'offroute', pct: good.pct, routeRoad: good.road ?? '', road: near ? MAP.roads[near.i].name : '', sLeave: good.sOn ?? null, at: now, nextN: st.next?.n };
      }
    } else offSince = null;
  }
  const zoom = (f) => { bias = Math.max(0.35, Math.min(3, bias * f)); };
  loadMap().then(() => draw(true)).catch(() => { status.hidden = false; status.textContent = 'The map isn’t on this tablet yet. Open the app once while online.'; });

  function update(st, live) { last = { st, live }; if (!raf && alive) raf = requestAnimationFrame(loop); }
  function loop() {
    raf = 0;
    if (!alive || !root.isConnected) return;
    if (container.offsetParent !== null) draw(false);   // hidden (map off): nothing to draw
    raf = requestAnimationFrame(loop);
  }

  function draw(force) {
    const now = performance.now();
    if (!force && now - drawnAt < 45) return;
    drawnAt = now;
    const dt = frameAt === null ? 1 : Math.min(0.5, (now - frameAt) / 1000);
    frameAt = now;
    const ease = (tau) => (force ? 1 : 1 - Math.exp(-dt / tau));
    const st = last?.st, live = last?.live;
    speed.textContent = st?.speed_mph != null ? `${Math.round(st.speed_mph)} mph` : '';
    if (!MAP) return;
    const fix = live?.lastFix;
    if (!fix) { status.hidden = false; status.textContent = 'Waiting for a GPS position…'; return; }
    status.hidden = MAP.inside(fix.lat, fix.lon);
    if (!status.hidden) status.textContent = store.get('area', null) ? 'Outside the downloaded map area.' : 'Outside the map area (Ashtabula to Erie). Settings → Map for the rally area.';
    // Heading up: the car's course while moving, the last one while stopped (north up only before the first move
    // ever), eased so the map turns smoothly.
    const v = (st?.speed_mph ?? 0) * 0.44704;
    const hd = live.headings?.[live.headings.length - 1], rb = routeBearing(live);
    // Up is the way the car goes: the locked route's own direction when on it and slow (steady at a stop sign),
    // the GPS course when moving, else the last one.
    if ((rb !== null && v < 4) || (hd && v > 1.5)) {
      heading = rb !== null && v < 4 ? rb : hd.h;
      if (now - headingSavedAt > 5000) { headingSavedAt = now; try { localStorage.setItem('rc.mapHeading', String(Math.round(heading))); } catch { /* no storage */ } }
    }
    if (heading !== null) rot = rot === null ? heading : (rot + (((heading - rot) % 360 + 540) % 360 - 180) * ease(0.35) + 360) % 360;
    const th = (rot ?? 0) * Math.PI / 180, cos = Math.cos(th), sin = Math.sin(th);

    const box = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(box.width)), H = Math.max(1, Math.round(box.height));
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    // Colours follow the theme.
    const cs = getComputedStyle(document.documentElement), css = (k, d) => cs.getPropertyValue(k).trim() || d;
    Object.assign(INK, { bg: css('--mapbg', INK.bg), major: css('--road-major', INK.major), road: css('--road', INK.road), minor: css('--road-minor', INK.minor),
      label: css('--maplabel', INK.label), onto: css('--info', INK.onto), track: css('--good', INK.track), bridge: css('--watch', INK.bridge), ink: css('--text', '#e8eaed'),
      route: css('--route', '#ff6bd6'), trail: css('--muted', INK.trail) });
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = INK.bg; ctx.fillRect(0, 0, W, H);

    // Car at (cx, cy), its heading up; world (x east, y north, metres) to screen. Zoom: the stretch ahead
    // shows the next instruction (with some road beyond it), at least 20 s of driving and 200 m, at most 2.5 km.
    const cx = W / 2, cy = H * 0.68;
    const toNext = st?.next?.to_mi != null && st.next.to_mi > 0 ? st.next.to_mi * 1609.344 : null;
    const ahead = Math.min(2500, Math.max(200, v * 20, toNext !== null ? toNext * 1.25 + 50 : 0));
    const want = Math.max(0.6, ahead / cy * bias);
    mpp = mpp === null || force ? want : mpp + (want - mpp) * ease(0.6);
    // The car: the last fix, carried on along the heading for the time since it (at most 1.2 s), then eased.
    const [fx, fy] = MAP.toLocal(fix.lat, fix.lon), lead = Number.isFinite(fix.t) ? Math.max(0, Math.min(1.2, now / 1000 - fix.t)) : 0;
    const hr = (hd?.h ?? heading ?? 0) * Math.PI / 180, tx = fx + v * lead * Math.sin(hr), ty = fy + v * lead * Math.cos(hr);
    if (!ren || force || Math.hypot(tx - ren[0], ty - ren[1]) > 250) ren = [tx, ty];
    else { const f = ease(0.12); ren = [ren[0] + (tx - ren[0]) * f, ren[1] + (ty - ren[1]) * f]; }
    const [x0, y0] = ren;
    const sx = (x, y) => cx + ((x - x0) * cos - (y - y0) * sin) / mpp;
    const sy = (x, y) => cy - ((x - x0) * sin + (y - y0) * cos) / mpp;
    const R = Math.hypot(W, H) * mpp;
    const vis = [...MAP.query(x0 - R, y0 - R, x0 + R, y0 + R)].map((i) => MAP.roads[i]);
    const k = Math.max(0.55, Math.min(1.4, 4 / mpp));
    const ontoKey = roadKey(st?.next?.ins?.onto);
    const path = (rd) => {
      const xy = rd.xy;
      ctx.moveTo(sx(xy[0], xy[1]), sy(xy[0], xy[1]));
      for (let j = 2; j < xy.length; j += 2) ctx.lineTo(sx(xy[j], xy[j + 1]), sy(xy[j], xy[j + 1]));
    };
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // Roads, minor classes first; service roads and tracks only when zoomed in.
    for (let c = 8; c >= 0; c--) {
      if (c >= 7 && mpp > 8) continue;
      ctx.beginPath();
      let any = false;
      for (const rd of vis) if (rd.c === c) { path(rd); any = true; }
      if (!any) continue;
      ctx.strokeStyle = c <= 3 ? INK.major : c <= 6 ? INK.road : INK.minor;
      ctx.lineWidth = WIDTH[c] * k;
      ctx.stroke();
    }
    // The road the next instruction turns onto (the locked route shows the turn itself).
    if (ontoKey && !live.lockLL) {
      ctx.beginPath();
      let any = false;
      for (const rd of vis) if (roadKeys(rd).includes(ontoKey)) { path(rd); any = true; }
      if (any) { ctx.strokeStyle = INK.onto; ctx.lineWidth = 9 * k; ctx.globalAlpha = 0.85; ctx.stroke(); ctx.globalAlpha = 1; }
    }
    // The route ahead: the app's best guess from the instructions, about once a second, with how sure it
    // is. Dashed under 60%, not drawn under 30%; each turn marker carries the chance the line is right to it.
    // The route locked at import: the whole of it in pink (what's behind the car fainter), and off the route the
    // way back in blue. It replaces the guess below.
    if (live.lockLL) {
      if (lockXY?.ll !== live.lockLL) lockXY = { ll: live.lockLL, xy: live.lockLL.map(([la, lo]) => MAP.toLocal(la, lo)) };
      const cum = live.tracker?.cum, sCar = live.tracker?.s ?? null, xy = lockXY.xy;
      let cut = 0;
      if (sCar !== null && cum) while (cut + 1 < cum.length && cum[cut + 1] <= sCar) cut++;
      // Where you're going: from the car on, thick pink with white chevrons pointing the way (in view only).
      const pts = [];
      for (let j = cut; j < xy.length; j++) {
        const [x, y] = xy[j];
        pts.push([sx(x, y), sy(x, y)]);
        if (Math.hypot(x - x0, y - y0) > R * 1.5 && pts.length > 2) break;
      }
      if (sCar !== null && !live.offRoute && pts.length) pts[0] = [cx, cy];   // from the car itself
      if (pts.length > 1) {
        ctx.beginPath(); pts.forEach(([X, Y], i) => (i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y)));
        ctx.strokeStyle = INK.bg; ctx.lineWidth = 9 * k + 6; ctx.globalAlpha = 0.6; ctx.stroke();
        ctx.strokeStyle = INK.route; ctx.lineWidth = 9 * k + 2; ctx.globalAlpha = 1; ctx.stroke();
        chevrons(ctx, pts, 70, Math.max(5, 5 * k), INK.bg);
      }
      // The next turns on it, numbered.
      let shown = 0;
      for (const t of live.lockTurns || []) {
        if (sCar !== null && t.s < sCar - 5) continue;
        if (shown++ >= 3) break;
        const [x, y] = MAP.toLocal(t.lat, t.lon), X = sx(x, y), Y = sy(x, y);
        ctx.beginPath(); ctx.arc(X, Y, 15, 0, 2 * Math.PI); ctx.fillStyle = INK.route; ctx.fill();
        ctx.lineWidth = 3; ctx.strokeStyle = INK.bg; ctx.stroke();
        ctx.font = '800 14px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = INK.bg;
        ctx.fillText(String(t.n), X, Y + 0.5);
      }
      const rc = live.recovery;
      if (live.offRoute && rc?.ll?.length > 1) {
        ctx.beginPath();
        rc.ll.forEach(([la, lo], i) => { const [x, y] = MAP.toLocal(la, lo); if (i) ctx.lineTo(sx(x, y), sy(x, y)); else ctx.moveTo(sx(x, y), sy(x, y)); });
        ctx.strokeStyle = INK.bridge; ctx.lineWidth = 8 * k + 2; ctx.globalAlpha = 0.95; ctx.setLineDash([18, 10]); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;   // amber: not the next turn's blue
      }
      guess.hidden = true; proj = null;
    } else if (GRAPH && projectRoute && live.started && st?.D != null && (force || now - projAt > 1000)) {
      projAt = now;
      try { proj = projectRoute(GRAPH, { x: x0, y: y0, headingDeg: v > 1.5 ? heading : null, D: st.D, rows: live.schedule.rows, maxTurns: 3 }); } catch (e) { proj = null; console.warn('route guess', e); }
    }
    if (proj && proj.path?.length > 1) {
      // The chip: how sure the line is to the next turn (the markers say it for the turns after).
      const pct = Math.round(100 * (proj.turns?.[0]?.path_conf ?? proj.turns?.[0]?.conf ?? proj.conf));
      guess.hidden = pct < 50;   // a guess under 50% says nothing useful
      guess.className = `mp-guess ${pct >= 75 ? 'mp-g-good' : pct >= 50 ? 'mp-g-watch' : 'mp-g-low'}`;
      guess.textContent = pct >= 30 ? `Route guess: ${pct}% sure` : `Route guess: not sure (${pct}%)`;
      if (pct >= 30) {
        ctx.beginPath();
        proj.path.forEach(([x, y], i) => (i ? ctx.lineTo(sx(x, y), sy(x, y)) : ctx.moveTo(sx(x, y), sy(x, y))));
        ctx.strokeStyle = INK.route; ctx.lineWidth = 6 * k + 2; ctx.globalAlpha = 0.9;
        ctx.setLineDash(pct < 60 ? [16, 10] : []); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
        let run = 1;
        for (const t of proj.turns || []) {
          run = t.path_conf ?? run * (t.conf ?? 1);   // the chance the line is right up to this turn
          const X = sx(t.x, t.y), Y = sy(t.x, t.y);
          ctx.beginPath(); ctx.arc(X, Y, 14, 0, 2 * Math.PI); ctx.fillStyle = INK.route; ctx.fill();
          ctx.lineWidth = 2; ctx.strokeStyle = INK.bg; ctx.stroke();
          ctx.font = '800 13px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = INK.bg;
          ctx.fillText(String(t.n), X, Y + 0.5);
          halo(ctx, `${t.dir === 'L' || t.dir === 'BL' ? '◀ ' : ''}${Math.round(100 * run)}%${t.dir === 'R' || t.dir === 'BR' ? ' ▶' : ''}`, X, Y + 25, INK.route, 'center', 13);
        }
      }
    } else guess.hidden = true;
    if (live.started && GRAPH && !live.lockLL) { try { checkOffRoute(x0, y0, v, now, st ?? {}, live); } catch (e) { console.warn('off-route check', e); } }   // locked: the tracker says
    // Where you've been: the 1 s track (the last 2 hours) as a thin grey dotted trail (each point converted once).
    const tr = live.track || [];
    if (trackXY.src !== tr || tr.length < trackXY.n) trackXY = { src: tr, n: 0, xy: [] };
    for (; trackXY.n < tr.length; trackXY.n++) trackXY.xy.push(MAP.toLocal(tr[trackXY.n][1], tr[trackXY.n][2]));
    if (trackXY.xy.length > 1) {
      ctx.beginPath();
      const from = Math.max(0, trackXY.xy.length - 7200);
      for (let j = from; j < trackXY.xy.length; j++) { const [x, y] = trackXY.xy[j]; if (j === from) ctx.moveTo(sx(x, y), sy(x, y)); else ctx.lineTo(sx(x, y), sy(x, y)); }
      ctx.lineTo(cx, cy);
      ctx.strokeStyle = INK.trail; ctx.lineWidth = 4; ctx.globalAlpha = 0.85; ctx.setLineDash([1, 8]); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    labels(ctx, vis, sx, sy, W, H, mpp, ontoKey);
    // Covered bridges.
    for (const b of MAP.bridges) {
      const X = sx(b.x, b.y), Y = sy(b.x, b.y);
      if (X < -60 || Y < -60 || X > W + 60 || Y > H + 60) continue;
      ctx.fillStyle = INK.bridge; ctx.strokeStyle = INK.bg; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(X, Y - 11); ctx.lineTo(X + 11, Y); ctx.lineTo(X, Y + 11); ctx.lineTo(X - 11, Y); ctx.closePath(); ctx.fill(); ctx.stroke();
      halo(ctx, b.name, X + 15, Y, INK.bridge, 'left', 15);
    }
    // The car.
    ctx.fillStyle = INK.ink; ctx.strokeStyle = INK.bg; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(cx, cy - 17); ctx.lineTo(cx + 12, cy + 12); ctx.lineTo(cx, cy + 6); ctx.lineTo(cx - 12, cy + 12); ctx.closePath(); ctx.stroke(); ctx.fill();
    // North arrow and scale.
    const nx = W - 36, ny = H - 48;
    ctx.beginPath(); ctx.arc(nx, ny, 20, 0, 2 * Math.PI); ctx.fillStyle = INK.bg; ctx.fill();
    ctx.save(); ctx.translate(nx, ny); ctx.rotate(-th);
    ctx.beginPath(); ctx.moveTo(0, -15); ctx.lineTo(6, 2); ctx.lineTo(-6, 2); ctx.closePath(); ctx.fillStyle = INK.ink; ctx.fill();
    halo(ctx, 'N', 0, 9, INK.ink, 'center', 11);
    ctx.restore();
    const ft = mpp * 120 / 0.3048, step = [100, 200, 500, 1000, 2640, 5280, 10560].find((s) => s >= ft / 2) ?? 10560;
    const px = step * 0.3048 / mpp, sxL = 12, syL = H - 30;
    ctx.strokeStyle = INK.ink; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(sxL, syL - 6); ctx.lineTo(sxL, syL); ctx.lineTo(sxL + px, syL); ctx.lineTo(sxL + px, syL - 6); ctx.stroke();
    halo(ctx, step >= 2640 ? `${step / 5280} mi` : `${step} ft`, sxL + px + 8, syL - 4, INK.ink, 'left', 13);
    // The road under the car.
    const near = nearestRoad(MAP, x0, y0, v > 1.5 ? heading : null);
    const nm = near ? MAP.roads[near.i].name : '';
    road.textContent = nm ? `On ${nm}` : '';
  }

  return { update, destroy() { alive = false; cancelAnimationFrame(raf); root.remove(); } };
}

// Road names: each name once, on its longest straight stretch in view, upright, without overlaps.
function labels(ctx, vis, sx, sy, W, H, mpp, ontoKey) {
  if (mpp > 12) return;
  const best = new Map();
  for (const rd of vis) {
    if (!rd.name || rd.c > 6) continue;
    const xy = rd.xy;
    for (let j = 0; j + 3 < xy.length; j += 2) {
      const ax = sx(xy[j], xy[j + 1]), ay = sy(xy[j], xy[j + 1]), bx = sx(xy[j + 2], xy[j + 3]), by = sy(xy[j + 2], xy[j + 3]);
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      if (mx < 30 || my < 30 || mx > W - 30 || my > H - 30) continue;
      const len = Math.hypot(bx - ax, by - ay), b = best.get(rd.name);
      if (!b || len > b.len) best.set(rd.name, { name: rd.name, len, mx, my, ang: Math.atan2(by - ay, bx - ax), c: rd.c, onto: ontoKey && roadKeys(rd).includes(ontoKey) });
    }
  }
  const placed = [];
  ctx.font = '700 15px system-ui, sans-serif';
  const cand = [...best.values()].sort((a, b) => (b.onto - a.onto) || (a.c - b.c) || (b.len - a.len));
  for (const L of cand) {
    if (placed.length >= 24) break;
    const w = ctx.measureText(L.name).width;
    if (L.len < w + 14) continue;
    let ang = L.ang;
    if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
    const hw = (Math.abs(Math.cos(ang)) * w + Math.abs(Math.sin(ang)) * 18) / 2, hh = (Math.abs(Math.sin(ang)) * w + Math.abs(Math.cos(ang)) * 18) / 2;
    if (placed.some((p) => Math.abs(p.x - L.mx) < p.hw + hw && Math.abs(p.y - L.my) < p.hh + hh)) continue;
    placed.push({ x: L.mx, y: L.my, hw, hh });
    ctx.save(); ctx.translate(L.mx, L.my); ctx.rotate(ang);
    halo(ctx, L.name, 0, 0, L.onto ? INK.onto : INK.label);
    ctx.restore();
  }
}

// Chevrons along a screen polyline every `gap` px, pointing the way it runs: where you're going, at a glance.
function chevrons(ctx, pts, gap, size, color) {
  let carry = gap / 2;
  ctx.strokeStyle = color; ctx.lineWidth = Math.max(2.5, size * 0.55); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], L = Math.hypot(bx - ax, by - ay);
    if (L < 1e-6) continue;
    const ux = (bx - ax) / L, uy = (by - ay) / L;
    let d = carry;
    for (; d < L; d += gap) {
      const px = ax + ux * d, py = ay + uy * d;
      ctx.beginPath();
      ctx.moveTo(px - ux * size - uy * size, py - uy * size + ux * size);
      ctx.lineTo(px, py);
      ctx.lineTo(px - ux * size + uy * size, py - uy * size - ux * size);
      ctx.stroke();
    }
    carry = d - L;
  }
}

// The locked route's direction at the car (from 5 m behind to 25 m ahead), when the car is on it: steady even
// when slow or stopped, where the GPS course wanders. Degrees from north, or null.
function routeBearing(live) {
  const tr = live?.tracker;
  if (!tr || !tr.on || tr.s === null || !(tr.dist <= 25)) return null;
  const at = (s) => {
    const { pts, cum } = tr;
    let k = 0;
    while (k + 2 < cum.length && cum[k + 1] < s) k++;
    const f = Math.max(0, Math.min(1, (s - cum[k]) / (cum[k + 1] - cum[k] || 1)));
    return [pts[k][0] + (pts[k + 1][0] - pts[k][0]) * f, pts[k][1] + (pts[k + 1][1] - pts[k][1]) * f];
  };
  const [ax, ay] = at(tr.s - 5), [bx, by] = at(tr.s + 25);
  return Math.hypot(bx - ax, by - ay) < 1 ? null : (Math.atan2(bx - ax, by - ay) * 180 / Math.PI + 360) % 360;
}
