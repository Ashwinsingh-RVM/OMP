/* Lumen — small UX layer on top of the app: live clock, greeting, and a
   Ctrl/⌘+K command palette that jumps to any shipment or page. Reads
   OMP.state only; every change still goes through the normal pages. */
(() => {
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ── clock + greeting ── */
  function tick() {
    const el = $('#lumenClock'); if (!el) return;
    el.textContent = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  tick(); setInterval(tick, 20000);

  function greet() {
    const u = window.OMP && OMP.state && OMP.state.user;
    const el = $('#lumenGreet');
    if (!u || !u.name || !el) return false;
    const h = new Date().getHours();
    const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const first = String(u.name).split(/[\s·]/)[0];
    el.innerHTML = `<b>${part}, ${esc(first)}</b>Press <kbd>Ctrl K</kbd> to jump to any shipment.`;
    return true;
  }
  const gi = setInterval(() => { if (greet()) clearInterval(gi); }, 400);

  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── power-level count-up: big numbers spin up from 0 when a page draws ── */
  const COUNT_SEL = '.d-big, .f-count, .d-flow li b, .kpi-v';
  function countUp(el) {
    // only ever rewrite a plain text node — never wipe out a link or <small> inside
    if (el.children.length === 1 && !el.firstElementChild.children.length && el.textContent.trim() === el.firstElementChild.textContent.trim()) el = el.firstElementChild;
    if (el.children.length) return;
    if (el.classList.contains('l-charging') || el.dataset.lCounted === el.textContent) return;
    const txt = el.textContent;
    const m = txt.match(/^([^\d]*)([\d,]+(?:\.\d+)?)(.*)$/s);
    if (!m) { el.dataset.lCounted = txt; return; }
    const target = parseFloat(m[2].replace(/,/g, ''));
    const dec = (m[2].split('.')[1] || '').length;
    if (!isFinite(target) || target === 0) { el.dataset.lCounted = txt; return; }
    const t0 = performance.now(), dur = 900;
    const fmt = v => m[1] + (dec ? v.toFixed(dec) : Math.round(v).toLocaleString('en-IN')) + m[3];
    el.classList.add('l-charging');
    let done = false;
    const finish = () => { if (done) return; done = true; el.textContent = txt; el.dataset.lCounted = txt; el.classList.remove('l-charging'); };
    (function step() {
      if (done) return;
      const p = Math.max(0, Math.min(1, (performance.now() - t0) / dur)), e = 1 - Math.pow(1 - p, 4);
      if (p >= 1) return finish();
      el.textContent = fmt(target * e);
      setTimeout(step, 30);
    })();
    // frames can stall (background tab, headless): the real number always lands
    setTimeout(finish, dur + 150);
  }
  if (!calm) {
    const views = document.querySelector('main.page');
    let pending = false;
    if (views) new MutationObserver(() => {
      if (pending) return; pending = true;
      setTimeout(() => { pending = false; document.querySelectorAll('.page-view.active ' + COUNT_SEL.split(', ').join(', .page-view.active ')).forEach(countUp); }, 0);
    }).observe(views, { childList: true, subtree: true });
  }
  /* ── hero banner: one headline from live data + an optional art slot ── */
  // Drop an image into public/art/ and it shows on the right of the banner:
  // <view>.png|gif|webp|jpg (orders / pipeline / dashboard) wins, else hero.*.
  const ART_EXT = ['png', 'gif', 'webp', 'jpg'];
  const artCache = {};
  function findArt(view) {
    if (artCache[view]) return artCache[view];
    const list = [view, 'hero'].flatMap(n => ART_EXT.map(e => '/art/' + n + '.' + e));
    artCache[view] = (async () => {
      for (const u of list) {
        try { const r = await fetch(u, { cache: 'force-cache' }); if (r.ok && /^image\//.test(r.headers.get('content-type') || '')) return u; } catch (e) { /* try next */ }
      }
      return null;
    })();
    return artCache[view];
  }

  function heroCopy(view) {
    const S = (window.OMP && OMP.state) || {};
    const all = S.shipments || [];
    const H = (window.OMP && OMP.helpers) || {};
    const pool = S.user && S.user.role !== 'admin' && H.myShipments ? H.myShipments() : all;
    const has = (r, k) => (r.attention || []).some(a => String(a).includes(k));
    const open = pool.filter(r => !r.closed && !/reject/i.test(r.stageLabel || ''));
    const attn = pool.filter(r => (r.attention || []).length).length;
    const late = pool.filter(r => has(r, 'payment_late')).length;
    const fup = pool.filter(r => has(r, 'followup')).length;
    const moving = open.filter(r => /transit/i.test(r.stageLabel || '')).length;
    const h = new Date().getHours();
    const hello = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const first = String((S.user && S.user.name) || '').split(/[\s·]/)[0];
    const date = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' });
    const chips = [
      { n: open.length, l: 'open' }, { n: moving, l: 'in transit' },
      { n: fup, l: 'follow-ups due', c: fup ? 'hot' : '' }, { n: late, l: 'payments late', c: late ? 'hot' : '' },
    ];
    const head = {
      orders: [`${attn} shipments`, 'need you today.'],
      pipeline: [`${open.length} on the move.`, `${moving} trucks on the road right now.`],
      dashboard: ['The whole board,', 'at a glance.'],
    }[view] || ['Mission control', 'is live.'];
    return { eyebrow: `${hello}${first ? ', ' + first : ''} · ${date}`, head, chips };
  }

  const hero = $('#lumenHero');
  let heroKey = '';
  function renderHero() {
    if (!hero || !window.OMP || !OMP.state) return;
    const view = OMP.state.view;
    const show = ['orders', 'pipeline', 'dashboard'].includes(view) && !/^#order\//.test(location.hash) && (OMP.state.shipments || []).length;
    hero.hidden = !show;
    if (!show) { heroKey = ''; return; }
    const c = heroCopy(view);
    const key = view + JSON.stringify(c);
    if (key === heroKey) return;
    const fresh = !heroKey.startsWith(view);
    heroKey = key;
    hero.innerHTML = `
      <div class="l-hero-copy">
        <p class="l-hero-eye">${esc(c.eyebrow)}</p>
        <h2 class="l-hero-h"><span>${esc(c.head[0])}</span> <em>${esc(c.head[1])}</em></h2>
        <ul class="l-hero-chips">${c.chips.map(x => `<li class="${x.c || ''}"><b>${x.n}</b>${esc(x.l)}</li>`).join('')}</ul>
      </div>`;
    findArt(view).then(u => {
      if (!u || OMP.state.view !== view || hero.querySelector('.l-hero-art')) return;
      const wrap = document.createElement('div'); wrap.className = 'l-hero-art';
      const img = new Image(); img.src = u; img.alt = '';
      wrap.appendChild(img); hero.appendChild(wrap); hero.classList.add('has-art');
    });
    hero.classList.remove('has-art');
    if (fresh && !calm) { hero.classList.remove('l-enter'); void hero.offsetWidth; hero.classList.add('l-enter'); }
  }
  setInterval(renderHero, 500);
  window.addEventListener('hashchange', renderHero);

  /* ── command palette ── */
  const PAGES = [
    { view: 'orders', label: 'Shipments', hint: 'Every order, needs-attention first', ico: '◎' },
    { view: 'sheet', label: 'Sheet', hint: 'All columns, spreadsheet view', ico: '▦' },
    { view: 'pipeline', label: 'Pipeline', hint: 'Stage board and funnel', ico: '⫶' },
    { view: 'dashboard', label: 'Dashboard', hint: 'Today at a glance', ico: '◔' },
    { view: 'team', label: 'Team & PINs', hint: 'People and access', ico: '◉' },
  ];
  let back, input, list, items = [], cur = 0;

  function build() {
    back = document.createElement('div');
    back.className = 'l-pal-back'; back.hidden = true;
    back.innerHTML = `
      <div class="l-pal" role="dialog" aria-modal="true" aria-label="Search">
        <div class="l-pal-in">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input type="text" placeholder="Search shipment ID, SO, buyer, seller, material…" autocomplete="off" spellcheck="false" />
          <kbd>Esc</kbd>
        </div>
        <div class="l-pal-list" role="listbox"></div>
        <div class="l-pal-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></div>
      </div>`;
    document.body.appendChild(back);
    input = back.querySelector('input'); list = back.querySelector('.l-pal-list');
    back.addEventListener('mousedown', e => { if (e.target === back) close(); });
    input.addEventListener('input', () => { cur = 0; render(); });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); if (items[cur]) items[cur].run(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
  }

  function hay(r) {
    const extra = Object.keys(r).filter(k => /so|invoice|vehicle|truck/i.test(k) && typeof r[k] !== 'object').map(k => r[k]);
    return [r.shipmentId, r.buyer, r.seller, r.material, r.stageLabel, r.owner, ...extra].join(' ').toLowerCase();
  }

  function render() {
    const q = input.value.trim().toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    const visible = PAGES.filter(p => { const b = document.querySelector(`.view-tab[data-view="${p.view}"]`); return b && !b.hidden; });
    const pages = visible.filter(p => !terms.length || terms.every(t => (p.label + ' ' + p.hint).toLowerCase().includes(t)));
    const all = (window.OMP && OMP.state.shipments) || [];
    const ships = (terms.length ? all.filter(r => { const h = hay(r); return terms.every(t => h.includes(t)); }) : all.filter(r => (r.attention || []).length)).slice(0, 8);

    items = [];
    let html = '';
    if (ships.length) {
      html += `<div class="l-pal-sec">${terms.length ? 'Shipments' : 'Needs attention'}</div>`;
      ships.forEach(r => {
        const i = items.length;
        items.push({ run: () => { close(); OMP.actions.setView('orders'); location.hash = 'order/' + encodeURIComponent(r.shipmentId); } });
        html += `<button class="l-pal-item" data-i="${i}" role="option"><i>⬡</i><span><b>${esc(r.buyer || r.shipmentId)}</b><small>${esc(r.shipmentId)}${r.material ? ' · ' + esc(r.material) : ''}</small></span><em>${esc(r.stageLabel || '')}</em></button>`;
      });
    }
    if (pages.length) {
      html += `<div class="l-pal-sec">Go to</div>`;
      pages.forEach(p => {
        const i = items.length;
        items.push({ run: () => { close(); if (p.view === 'orders' && location.hash.startsWith('#order/')) location.hash = ''; OMP.actions.setView(p.view); } });
        html += `<button class="l-pal-item" data-i="${i}" role="option"><i>${p.ico}</i><span><b>${esc(p.label)}</b><small>${esc(p.hint)}</small></span><em>Page</em></button>`;
      });
    }
    list.innerHTML = html || `<div class="l-pal-empty">Nothing matches “${esc(input.value)}”</div>`;
    list.querySelectorAll('.l-pal-item').forEach(b => {
      b.addEventListener('mouseenter', () => { cur = +b.dataset.i; mark(); });
      b.addEventListener('click', () => items[+b.dataset.i].run());
    });
    mark();
  }
  function mark() {
    list.querySelectorAll('.l-pal-item').forEach(b => b.classList.toggle('on', +b.dataset.i === cur));
    const on = list.querySelector('.l-pal-item.on'); if (on) on.scrollIntoView({ block: 'nearest' });
  }
  function move(d) { if (!items.length) return; cur = (cur + d + items.length) % items.length; mark(); }
  function open() { if (!back) build(); back.hidden = false; input.value = ''; cur = 0; render(); setTimeout(() => input.focus(), 0); }
  function close() { if (back) back.hidden = true; }

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); back && !back.hidden ? close() : open(); }
    else if (e.key === '/' && !/input|textarea|select/i.test((e.target.tagName || '')) && !e.target.isContentEditable) { e.preventDefault(); open(); }
  });
  const btn = $('#lumenSearch'); if (btn) btn.addEventListener('click', open);
})();

