// Map view for the Drive screen: the offline road map around the car, turning with the car (heading up)
// and zooming by itself so the next instruction fits, with the track driven so far, covered bridges and
// road names. The road the next instruction turns onto is drawn in blue. + and − bias the zoom.
// mountMap(container) -> { update(state, live), destroy() }
import { h } from './dom.js';
import { decodeMap, roadKey, roadKeys, nearestRoad } from '../core/mapview.js';

let MAP = null, LOADING = null;   // decoded once, shared by every mount
export function loadMap(url = 'map/roads.json') {
  LOADING ??= fetch(url).then((r) => { if (!r.ok) throw new Error(`map ${r.status}`); return r.json(); })
    .then((doc) => (MAP = decodeMap(doc)))
    .catch((err) => { LOADING = null; throw err; });
  return LOADING;
}

const WIDTH = [7, 6.5, 6, 5.5, 5, 4, 4, 2.2, 1.6];   // line width by road class: motorway … track
const INK = { bg: '#0e1217', major: '#8b97a4', road: '#5f6a76', minor: '#434b55', label: '#c9d1d9', onto: '#7cc4ff', track: '#3ddc84', bridge: '#f5b942' };

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
  const root = h('div', { class: 'mp-root' }, canvas, speed,
    h('div', { class: 'mp-tools' }, btn('+', 'Zoom in', () => zoom(0.7)), btn('−', 'Zoom out', () => zoom(1.45))),
    road, status, h('div', { class: 'mp-attr' }, '© OpenStreetMap contributors'));
  container.append(root);
  // bias: the crew's zoom on top of the automatic one; rot: the drawn heading, eased toward the car's.
  let bias = 1, mpp = null, last = null, drawnAt = 0, heading = null, rot = null;
  const zoom = (f) => { bias = Math.max(0.35, Math.min(3, bias * f)); draw(true); };
  loadMap().then(() => draw(true)).catch(() => { status.hidden = false; status.textContent = 'The map isn’t on this tablet yet. Open the app once while online.'; });

  function update(st, live) { last = { st, live }; draw(false); }

  function draw(force) {
    const now = performance.now();
    if (!force && now - drawnAt < 200) return;
    drawnAt = now;
    const st = last?.st, live = last?.live;
    speed.textContent = st?.speed_mph != null ? `${Math.round(st.speed_mph)} mph` : '';
    if (!MAP) return;
    const fix = live?.lastFix;
    if (!fix) { status.hidden = false; status.textContent = 'Waiting for a GPS position…'; return; }
    status.hidden = MAP.inside(fix.lat, fix.lon);
    if (!status.hidden) status.textContent = 'Outside the map area (Ashtabula to Erie).';
    // Heading up: the car's course once it's moving (north up until then), eased so the map turns smoothly.
    const v = (st?.speed_mph ?? 0) * 0.44704;
    const hd = live.headings?.[live.headings.length - 1];
    if (hd && v > 1.5) heading = hd.h;
    if (heading !== null) rot = rot === null ? heading : (rot + (((heading - rot) % 360 + 540) % 360 - 180) * (force ? 1 : 0.35) + 360) % 360;
    const th = (rot ?? 0) * Math.PI / 180, cos = Math.cos(th), sin = Math.sin(th);

    const box = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(box.width)), H = Math.max(1, Math.round(box.height));
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    // Colours follow the theme.
    const cs = getComputedStyle(document.documentElement), css = (k, d) => cs.getPropertyValue(k).trim() || d;
    Object.assign(INK, { bg: css('--mapbg', INK.bg), major: css('--road-major', INK.major), road: css('--road', INK.road), minor: css('--road-minor', INK.minor),
      label: css('--maplabel', INK.label), onto: css('--info', INK.onto), track: css('--good', INK.track), bridge: css('--watch', INK.bridge), ink: css('--text', '#e8eaed') });
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = INK.bg; ctx.fillRect(0, 0, W, H);

    // Car at (cx, cy), its heading up; world (x east, y north, metres) to screen. Zoom: the stretch ahead
    // shows the next instruction (with some road beyond it), at least 20 s of driving and 200 m, at most 2.5 km.
    const cx = W / 2, cy = H * 0.68;
    const toNext = st?.next?.to_mi != null && st.next.to_mi > 0 ? st.next.to_mi * 1609.344 : null;
    const ahead = Math.min(2500, Math.max(200, v * 20, toNext !== null ? toNext * 1.25 + 50 : 0));
    const want = Math.max(0.6, ahead / cy * bias);
    mpp = mpp === null || force ? want : mpp + (want - mpp) * 0.3;
    const [x0, y0] = MAP.toLocal(fix.lat, fix.lon);
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
    // The road the next instruction turns onto.
    if (ontoKey) {
      ctx.beginPath();
      let any = false;
      for (const rd of vis) if (roadKeys(rd).includes(ontoKey)) { path(rd); any = true; }
      if (any) { ctx.strokeStyle = INK.onto; ctx.lineWidth = 9 * k; ctx.globalAlpha = 0.85; ctx.stroke(); ctx.globalAlpha = 1; }
    }
    // The track driven so far (1 s points; the last 2 hours).
    const tr = live.track || [];
    if (tr.length > 1) {
      ctx.beginPath();
      const from = Math.max(0, tr.length - 7200);
      for (let j = from; j < tr.length; j++) {
        const [x, y] = MAP.toLocal(tr[j][1], tr[j][2]);
        if (j === from) ctx.moveTo(sx(x, y), sy(x, y)); else ctx.lineTo(sx(x, y), sy(x, y));
      }
      ctx.lineTo(cx, cy);
      ctx.strokeStyle = INK.track; ctx.lineWidth = 4; ctx.globalAlpha = 0.75; ctx.stroke(); ctx.globalAlpha = 1;
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

  return { update, destroy() { root.remove(); } };
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
