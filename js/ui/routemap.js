// Route overview map for the Verify screen: the whole route as it was locked onto the road map at import,
// north up, fitted to the route, so the crew can see every turn before driving.
// mountRouteMap(container, { lock, instructions, map, onStep }) -> { update(lock), destroy() }
import { h, clear } from './dom.js';

const HIT_PX = 28;   // tap target: a marker is hit within this many CSS px of its centre
const MARGIN = 36;   // empty space kept around the route when fitted, in CSS px
const WIDTH = [5, 4.5, 4, 3.5, 3, 2.4, 2.4, 1.6, 1.2];   // background road width by class: motorway ... track

// Read the theme colours on each draw (so a theme change shows up on the next redraw).
function inks(el) {
  const cs = getComputedStyle(el), v = (n, d) => cs.getPropertyValue(n).trim() || d;
  return { bg: v('--mapbg', '#0e1217'), major: v('--road-major', '#8b97a4'), road: v('--road', '#5f6a76'), minor: v('--road-minor', '#434b55'),
    route: v('--route', '#ff6bd6'), watch: v('--watch', '#f5b942'), text: v('--text', '#e8eaed'), panel: v('--panel', '#151a20'), onWatch: v('--on-watch', '#1a1200') };
}

// A projection from lat/lon to local metres: the offline map's own if given, else equirectangular around the centre.
function makeProject(map, ll) {
  if (map && map.toLocal) return (lat, lon) => map.toLocal(lat, lon);
  let la0 = 0, lo0 = 0;
  for (const [la, lo] of ll) { la0 += la; lo0 += lo; }
  la0 /= ll.length || 1; lo0 /= ll.length || 1;
  const k = 111320 * Math.cos(la0 * Math.PI / 180);
  return (lat, lon) => [(lon - lo0) * k, (lat - la0) * 110540];
}

function bounds(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return { x0, y0, x1, y1 };
}

export function mountRouteMap(container, { lock = null, instructions = [], map = null, onStep = () => {} } = {}) {
  const canvas = h('canvas', { class: 'rm-canvas' });
  const msg = h('div', { class: 'rm-msg', hidden: true });
  const pop = h('div', { class: 'rm-pop', hidden: true });
  const btn = (label, aria, fn) => h('button', { class: 'rm-btn', type: 'button', 'aria-label': aria, onclick: fn }, label);
  const root = h('div', { class: 'rm-root' }, canvas, msg, pop,
    h('div', { class: 'rm-tools' }, btn('+', 'Zoom in', () => zoomBy(1.5)), btn('−', 'Zoom out', () => zoomBy(1 / 1.5)), btn('Fit', 'Fit the whole route', () => { touched = false; fit(); draw(); })));
  container.appendChild(root);

  let pts = [], marks = [], startEnd = null;   // projected route (metres), step markers, S/F points
  let cx = 0, cy = 0, sc = 1, W = 0, H = 0, dpr = 1, picked = null;   // view: centre (m), px per metre, size
  let dead = false, touched = false;   // touched: the user has panned/zoomed, so a resize must not re-fit

  // Turn the lock into projected metres. Returns false when there is nothing to draw.
  function load(L) {
    pts = []; marks = []; startEnd = null; picked = null; pop.hidden = true;
    const ok = !!(L && !L.error && L.path && L.path.ll && L.path.ll.length > 1);
    root.classList.toggle('rm-empty', !ok);
    msg.hidden = ok;
    if (!ok) {
      msg.textContent = L && L.error === 'start' ? 'The route start could not be found on the map, so the route is not locked.'
        : L && L.error === 'none' ? 'The route could not be matched to the road map.' : 'No locked route yet.';
      return false;
    }
    const proj = makeProject(map, L.path.ll);
    pts = L.path.ll.map(([la, lo]) => proj(la, lo));
    marks = (L.rows || []).filter((r) => r.turn && r.lat != null && r.lon != null)
      .map((r) => ({ n: r.n, flag: !!r.flag, why: r.why || null, road: r.road || null, p: proj(r.lat, r.lon) }));
    startEnd = [pts[0], pts[pts.length - 1]];
    return true;
  }

  // Fit the view to the route's bounds with a margin.
  function fit() {
    if (!pts.length || !W || !H) return;
    const b = bounds(pts), w = Math.max(b.x1 - b.x0, 50), hh = Math.max(b.y1 - b.y0, 50);
    sc = Math.min((W - 2 * MARGIN) / w, (H - 2 * MARGIN) / hh);
    cx = (b.x0 + b.x1) / 2; cy = (b.y0 + b.y1) / 2;
  }
  const sx = (x) => W / 2 + (x - cx) * sc, sy = (y) => H / 2 - (y - cy) * sc;   // metres -> CSS px (north up)

  function resize() {
    const r = container.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height)); dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    if (!touched) fit();
    draw();
  }

  // Background roads from the offline map, only those in view, thinner for minor classes.
  function drawRoads(ctx, ink) {
    if (!map || !map.query || !map.roads) return;
    const x0 = cx - W / 2 / sc, x1 = cx + W / 2 / sc, y0 = cy - H / 2 / sc, y1 = cy + H / 2 / sc;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const i of map.query(x0, y0, x1, y1)) {
      const rd = map.roads[i], c = rd.c ?? 5, xy = rd.xy, w0 = WIDTH[c] ?? 1.5;
      ctx.strokeStyle = c <= 2 ? ink.major : c <= 5 ? ink.road : ink.minor;
      ctx.lineWidth = Math.max(0.8, Math.min(w0, w0 * Math.sqrt(sc * 4)));
      ctx.beginPath();
      for (let k = 0; k < xy.length; k += 2) { const X = sx(xy[k]), Y = sy(xy[k + 1]); k ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); }
      ctx.stroke();
    }
  }

  function drawPath(ctx, ink) {
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    pts.forEach(([x, y], k) => (k ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y))));
    ctx.strokeStyle = ink.bg; ctx.lineWidth = 9; ctx.stroke();   // a dark edge so pink reads over any roads
    ctx.strokeStyle = ink.route; ctx.lineWidth = 5.5; ctx.stroke();
  }

  // A filled disc with a centred label.
  function disc(ctx, x, y, r, fill, ring, label, labelColor, font) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = ring; ctx.stroke();
    ctx.fillStyle = labelColor; ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y + 0.5);
  }

  function drawMarkers(ctx, ink) {
    const [s, f] = startEnd;
    disc(ctx, sx(s[0]), sy(s[1]), 13, ink.route, ink.bg, 'S', ink.bg, '800 14px system-ui, sans-serif');
    disc(ctx, sx(f[0]), sy(f[1]), 13, ink.route, ink.bg, 'F', ink.bg, '800 14px system-ui, sans-serif');
    for (const m of marks) {
      const x = sx(m.p[0]), y = sy(m.p[1]), sel = picked === m, r = sel ? 15 : 12;
      const fs = String(m.n).length > 2 ? 10 : 12;
      disc(ctx, x, y, r, m.flag ? ink.watch : ink.panel, sel ? ink.text : (m.flag ? ink.bg : ink.route), String(m.n), m.flag ? ink.onWatch : ink.text, `700 ${fs}px system-ui, sans-serif`);
      if (m.flag) disc(ctx, x + 10, y - 10, 7, ink.bg, ink.watch, '!', ink.watch, '800 11px system-ui, sans-serif');
    }
  }

  function draw() {
    if (dead || !W) return;
    const ctx = canvas.getContext('2d'), ink = inks(root);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = ink.bg; ctx.fillRect(0, 0, W, H);
    if (!pts.length) return;
    drawRoads(ctx, ink); drawPath(ctx, ink); drawMarkers(ctx, ink);
    placePop();
  }

  // The popup sits just above the picked marker (below it near the top edge); moved on every redraw.
  function placePop() {
    if (!picked) { pop.hidden = true; return; }
    pop.hidden = false;
    const x = sx(picked.p[0]), y = sy(picked.p[1]), pw = pop.offsetWidth, ph = pop.offsetHeight;
    pop.style.left = Math.max(4, Math.min(W - pw - 4, x - pw / 2)) + 'px';
    pop.style.top = (y - ph - 20 < 4 ? y + 20 : y - ph - 20) + 'px';
  }
  function showPop(m) {
    picked = m;
    const ins = instructions.find((i) => i.n === m.n), om = ins && ins.om != null ? ` · OM ${Number(ins.om).toFixed(2)}` : '';
    clear(pop).append(h('b', null, `#${m.n}${om}${m.road ? ` · onto ${m.road}` : ''}`));
    if (ins && ins.text) pop.append(h('div', { class: 'rm-pop-text' }, ins.text));
    if (m.flag) pop.append(h('div', { class: 'rm-pop-why' }, '! ' + (m.why || 'Check this turn')));
    pop.hidden = false; draw();
  }

  function hit(px, py) {
    let best = null, bd = HIT_PX;
    for (const m of marks) { const d = Math.hypot(sx(m.p[0]) - px, sy(m.p[1]) - py); if (d <= bd) { bd = d; best = m; } }
    return best;
  }

  // Zoom about a screen point so what is under it stays put.
  function zoomBy(k, px = W / 2, py = H / 2) {
    touched = true;
    const wx = cx + (px - W / 2) / sc, wy = cy - (py - H / 2) / sc;
    sc = Math.max(0.005, Math.min(40, sc * k));
    cx = wx - (px - W / 2) / sc; cy = wy + (py - H / 2) / sc;
    draw();
  }

  // Pointer events: one pointer pans, two pinch-zoom; a press that barely moved is a tap.
  const ptrs = new Map(); let moved = 0, pinch = 0;
  const dist = () => { const [a, b] = [...ptrs.values()]; return Math.hypot(a[0] - b[0], a[1] - b[1]) || 1; };
  const mid = () => { const [a, b] = [...ptrs.values()]; return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; };
  canvas.addEventListener('pointerdown', (e) => {
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointers can't be captured */ }
    ptrs.set(e.pointerId, [e.offsetX, e.offsetY]); moved = 0;
    pinch = ptrs.size === 2 ? dist() : 0;
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId); if (!p) return;
    const dx = e.offsetX - p[0], dy = e.offsetY - p[1]; ptrs.set(e.pointerId, [e.offsetX, e.offsetY]);
    moved += Math.abs(dx) + Math.abs(dy);
    if (ptrs.size === 2) { const d = dist(), [mx, my] = mid(); if (pinch) zoomBy(d / pinch, mx, my); pinch = d; }
    else { touched = true; cx -= dx / sc; cy += dy / sc; draw(); }
  });
  const up = (e) => {
    const p = ptrs.get(e.pointerId); ptrs.delete(e.pointerId); pinch = 0;
    if (!p || e.type === 'pointercancel' || moved > 8 || ptrs.size) return;
    const m = hit(e.offsetX, e.offsetY);
    if (m) { showPop(m); onStep(m.n); } else if (picked) { picked = null; draw(); }
  };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.offsetX, e.offsetY); }, { passive: false });

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(container); else window.addEventListener('resize', resize);
  load(lock); resize(); fit(); draw();

  return {
    update(next) { load(next); touched = false; fit(); draw(); },   // a new lock: re-project and re-fit
    destroy() { dead = true; if (ro) ro.disconnect(); else window.removeEventListener('resize', resize); root.remove(); },
  };
}
