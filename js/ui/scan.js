// Photograph / pick the instruction pages, then read them.
import { h, clear } from './dom.js';

export function mountScan(container, opts) {
  const { onPagesChanged = () => {}, onExtract = () => {}, onPasteText = () => {} } = opts;
  let profile = opts.profile || 'offline';
  let pages = [];
  const prog = new Map(); // page -> { passes: {A:{state,message,t0,dur}}, kind, rows }
  let result = null;      // from finished(): { failedPages, pageKinds }
  const progBox = h('div', { 'aria-live': 'polite' });
  const COST = 0.13, SECS = 30, PAR = 4;   // measured 2026-10-31: 22 photos, $2.62, 159 s with 4 at a time
  const KIND_LABEL = { route: 'Route', general: 'GI', other: 'Other' };
  let pasteText = '';
  let destroyed = false;

  const root = h('div', { class: 'screen scan' });
  container.appendChild(root);

  const fileInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', multiple: true, style: { display: 'none' },
    onchange: e => addFiles([...e.target.files]).then(() => { e.target.value = ''; }) });
  const pickInput = h('input', { type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' },
    onchange: e => addFiles([...e.target.files]).then(() => { e.target.value = ''; }) });

  function measure(url) {
    return new Promise(res => {
      const im = new Image();
      im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
      im.onerror = () => res({ w: 0, h: 0 });
      im.src = url;
    });
  }
  async function addFiles(files) {
    files = files.slice().sort((a, b) => (a.lastModified || 0) - (b.lastModified || 0));   // new batch in shooting order
    for (const file of files) {
      const url = URL.createObjectURL(file);
      const { w, h: hh } = await measure(url);
      if (destroyed) { URL.revokeObjectURL(url); return; }
      pages.push({ page: 0, file, url, w, h: hh });
    }
    changed();
  }
  function renumber() { pages.forEach((p, i) => { p.page = i + 1; }); }
  function changed() { renumber(); render(); onPagesChanged(pages.slice()); }
  function move(i, d) {
    const j = i + d;
    if (j < 0 || j >= pages.length) return;
    [pages[i], pages[j]] = [pages[j], pages[i]];
    changed();
  }
  function remove(i) {
    URL.revokeObjectURL(pages[i].url);
    pages.splice(i, 1);
    changed();
  }

  const profileText = () => profile === 'cloud' ? 'Cloud reading (rallymaster approved)' : 'Offline reading';
  const passes = () => profile === 'cloud' ? ['A', 'B'] : ['ocr'];

  // ---- progress ----
  function pageState(p) {
    const r = prog.get(p.page);
    if (!r) return 'queued';
    const ps = Object.values(r.passes);
    if (ps.some((v) => v.state === 'running')) return 'reading';
    if (ps.some((v) => v.state === 'retry')) return 'retrying';
    if (ps.some((v) => v.state === 'error')) return 'failed';
    const ok = (k) => r.passes[k] && (r.passes[k].state === 'done' || r.passes[k].state === 'skipped');
    if (r.passes.ocr) return ok('ocr') ? 'done' : 'reading';
    if (r.kind === 'general') return ok('G') ? 'done' : 'reading';
    if (r.kind === 'other') return ok('A') ? 'done' : 'reading';
    return ok('A') && ok('B') ? 'done' : 'reading';
  }
  function etaText(left, durs) {
    if (!left) return '';
    const avg = durs.length ? durs.reduce((x, y) => x + y, 0) / durs.length : SECS;
    const secs = left * avg / PAR;
    return secs < 60 ? 'under a minute left' : `about ${Math.ceil(secs / 60)} min left`;
  }
  function renderProgress() {
    clear(progBox);
    if (!prog.size && !result) return;
    const states = pages.map(pageState);
    const count = (st) => states.filter((x) => x === st).length;
    const done = count('done'), retrying = count('retrying'), failed = count('failed');
    const left = pages.length - done - failed;
    const durs = [];
    for (const r of prog.values()) {
      const ds = Object.values(r.passes).map((v) => v.dur);
      if (ds.length && ds.every((d) => d != null)) durs.push(ds.reduce((x, y) => x + y, 0));
    }
    const line = [`${done} of ${pages.length} pages read`];
    if (retrying) line.push(`${retrying} retrying`);
    if (failed) line.push(`${failed} failed`);
    if (left > 0 && !result) line.push(etaText(left, durs));
    const chips = pages.map((p, i) => {
      const st = states[i], r = prog.get(p.page) || {};
      const label = r.kind && st === 'done' ? (KIND_LABEL[r.kind] || r.kind) : null;
      const rows = r.kind === 'route' && r.rows != null ? ` · ${r.rows} rows` : '';
      return h('div', { class: 'pg-chip pg-' + st, title: r.message || '' },
        h('b', { class: 'pg-n' }, String(p.page)),
        h('span', { class: 'pg-st' }, st),
        label ? h('span', { class: 'pg-kind pg-kind-' + r.kind }, label + rows) : null);
    });
    const bad = pages.filter((p, i) => states[i] === 'failed').map((p) => p.page);
    progBox.append(h('div', { class: 'panel' }, h('h3', null, 'Reading'),
      h('div', { class: 'pg-line' }, line.filter(Boolean).join(' · ')),
      h('div', { class: 'bar', style: { margin: '8px 0 12px' } }, h('i', { style: { width: (pages.length ? done / pages.length * 100 : 0) + '%' } })),
      h('div', { class: 'pg-grid' }, chips),
      bad.length ? h('div', { class: 'pg-fail' }, `Failed: page${bad.length > 1 ? 's' : ''} ${bad.join(', ')}`) : null,
      result ? summaryEl() : null));
  }
  function summaryEl() {
    const kinds = result.pageKinds || {};
    const list = kinds instanceof Map ? [...kinds.values()] : Array.isArray(kinds) ? kinds : Object.values(kinds);
    const n = (k) => list.filter((x) => (x && x.kind ? x.kind : x) === k).length;
    const parts = [];
    if (n('route')) parts.push(`${n('route')} route`);
    if (n('general')) parts.push(`${n('general')} general instructions`);
    if (n('other')) parts.push(`${n('other')} other`);
    const nf = (result.failedPages || []).length;
    return h('div', { class: 'pg-summary ' + (nf ? 'watch' : 'good') },
      nf ? `${nf} page${nf > 1 ? 's' : ''} could not be read: ${result.failedPages.join(', ')}. The rest are kept.` : 'All pages read.',
      parts.length ? ` Found: ${parts.join(', ')}.` : '');
  }
  function startReading() {
    // a re-read keeps the pages that finished; only the rest are cleared (the caller skips finished pages)
    const keep = result ? new Set(pages.filter((p) => pageState(p) === 'done').map((p) => p.page)) : new Set();
    for (const k of [...prog.keys()]) if (!keep.has(k)) prog.delete(k);
    result = null; renderProgress(); onExtract(pages.slice());
  }
  function estimateEl() {
    if (profile !== 'cloud' || !pages.length) return null;
    const n = pages.length, mins = Math.max(1, Math.ceil(n * SECS / PAR / 60));
    return h('div', { class: 'muted', style: { marginBottom: '8px' } }, `${n} page${n > 1 ? 's' : ''} ≈ $${(n * COST).toFixed(2)}, about ${mins} min`);
  }

  function render() {
    const keepPaste = pasteText;
    clear(root);
    renderProgress();
    const ta = h('textarea', { class: 'mono', placeholder: 'Paste or type the route instructions, one per line', 'aria-label': 'Instructions text', value: keepPaste });
    ta.addEventListener('input', () => { pasteText = ta.value; });
    root.append(...[
      h('div', { class: 'panel' },
        h('h1', null, 'Photograph the instruction pages'),
        h('div', { class: 'tip' }, "Quickest: photograph every page with the Camera app, then Pick from files and select them all. Order doesn't matter: instruction numbers put the rows in order."),
        h('div', { class: 'badge ' + (profile === 'cloud' ? 'watch' : 'info') }, profileText()),
        h('div', { class: 'row', style: { marginTop: '12px' } },
          h('button', { class: 'btn-info grow', onclick: () => fileInput.click() }, '📷 Add page'),
          h('button', { class: 'grow', onclick: () => pickInput.click() }, 'Pick from files'))),
      // The read button and progress stay at the top; with many pages the thumbnails fold away.
      pages.length ? h('div', { class: 'panel' },
        h('h2', null, `${pages.length} page${pages.length > 1 ? 's' : ''} in order`),
        h('div', { style: { margin: '12px 0' } }, estimateEl(),
          h('button', { class: 'btn-primary', style: { width: '100%' }, onclick: startReading },
            result && (result.failedPages || []).length ? `Read the ${result.failedPages.length} unfinished pages again` : 'Read pages')),
        (() => {
          const thumbs = pages.map((p, i) => h('div', { class: 'thumb' },
            h('img', { src: p.url, alt: `Page ${p.page}` }),
            h('div', { class: 'grow' }, h('b', null, `Page ${p.page}`), h('div', { class: 'muted' }, p.w ? `${p.w}×${p.h}` : 'unknown size')),
            h('button', { 'aria-label': 'Move up', disabled: i === 0, onclick: () => move(i, -1) }, '▲'),
            h('button', { 'aria-label': 'Move down', disabled: i === pages.length - 1, onclick: () => move(i, 1) }, '▼'),
            h('button', { 'aria-label': `Remove page ${p.page}`, class: 'btn-watch', onclick: () => remove(i) }, '✕')));
          return pages.length > 6
            ? h('details', null, h('summary', { style: { minHeight: '44px', cursor: 'pointer', display: 'flex', alignItems: 'center' } }, 'Show, reorder or remove pages'), ...thumbs)
            : h('div', null, ...thumbs);
        })()) : null,
      progBox,
      h('details', { class: 'panel', open: !!keepPaste },
        h('summary', { style: { minHeight: '44px', cursor: 'pointer', display: 'flex', alignItems: 'center' } }, 'Type or paste instructions'),
        ta,
        h('div', { style: { marginTop: '10px' } },
          h('button', { class: 'btn-info', onclick: () => { if (pasteText.trim()) onPasteText(pasteText); } }, 'Use this text'))),
      fileInput, pickInput].filter(Boolean));   // Element.append would print null as "null"
  }

  render();

  return {
    progress({ page, pass, state, message, kind }) {
      let r = prog.get(page);
      if (!r) { r = { passes: {}, kind: null, rows: null, message: '' }; prog.set(page, r); }
      const cur = r.passes[pass] || {};
      if (state === 'running') cur.t0 = Date.now();
      if (state === 'done') cur.dur = cur.t0 != null ? (Date.now() - cur.t0) / 1000 : SECS;
      cur.state = state; cur.message = message;
      r.passes[pass] = cur;
      if (kind) r.kind = kind;
      if (message) r.message = message;
      const m = /(\d+)\s*rows?/i.exec(message || '');
      if (m && pass !== 'B') r.rows = Number(m[1]);
      renderProgress();   // only the progress box, so the page list and typed text stay put
    },
    finished({ failedPages = [], pageKinds = {} } = {}) {
      result = { failedPages, pageKinds };
      for (const [pg, k] of (pageKinds instanceof Map ? pageKinds : Object.entries(pageKinds))) {
        const r = prog.get(Number(pg)), kk = k && k.kind ? k.kind : k;
        if (r && typeof kk === 'string') r.kind = kk;
      }
      render();
    },
    setProfile(p) { profile = p; render(); },
    destroy() {
      destroyed = true;
      pages.forEach(p => URL.revokeObjectURL(p.url));
      root.remove();
    },
  };
}
