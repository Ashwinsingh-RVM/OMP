/* Page: Dashboard — one calm summary instead of the old ten report tabs.
   Every number is a link: it opens Shipments already filtered to exactly those rows. */
(() => {
  const FLOW = ['mm', 'predispatch', 'intransit', 'reached', 'qc', 'completed', 'rejected'];
  let scope = null;

  OMP.registerPage('dashboard', {
    render(el, OMP) {
      const { state, helpers: H, actions: A } = OMP;
      const esc = H.esc;
      if (!scope) scope = state.user.role === 'admin' ? 'all' : 'mine';
      const me = String(state.user.name || '').trim().toLowerCase();
      const named = v => String(v || '').split('/').some(n => n.trim().toLowerCase() === me);
      const rows = scope === 'mine' ? state.shipments.filter(s => named(s.owner) || named(s.paymentOwner)) : state.shipments;

      const open = rows.filter(s => !s.closed && s.funnel !== 'rejected');
      const has = (s, k) => (s.attention || []).includes(k);
      const attn = rows.filter(s => (s.attention || []).length);
      const billed = rows.filter(s => s.funnel !== 'rejected' && H.num(s.balance) > 1);
      const late = rows.filter(s => s.paymentRisk === 'overdue');
      const sum = (list, f) => list.reduce((a, s) => a + H.num(f(s)), 0);
      const now = new Date();
      const month = now.toISOString().slice(0, 7);
      const collected = rows.filter(s => String(s.paymentDate || '').slice(0, 7) === month);
      const in7 = new Date(now.getTime() + 7 * 86400000).toISOString().slice(0, 10);
      const today = now.toISOString().slice(0, 10);
      const dueSoon = billed.filter(s => s.dueDate && s.dueDate >= today && s.dueDate <= in7);
      const stageLabel = k => (state.stages.find(x => x.key === k) || {}).label || k;
      const sentence = t => { const v = String(t || ''); return v.charAt(0).toUpperCase() + v.slice(1).toLowerCase(); };

      const link = (params, html, cls = '') => `<button class="d-link ${cls}" data-go="${esc(new URLSearchParams({ scope, ...params }).toString())}">${html}</button>`;

      const owners = {};
      if (scope === 'all') {
        for (const s of state.shipments) {
          for (const raw of String(s.owner || 'Unassigned').split('/')) {
            const n = raw.trim() || 'Unassigned';
            const o = owners[n] || (owners[n] = { open: 0, attn: 0, late: 0, bal: 0 });
            if (!s.closed && s.funnel !== 'rejected') o.open++;
            if ((s.attention || []).length) o.attn++;
            if (s.paymentRisk === 'overdue') o.late++;
            if (s.funnel !== 'rejected') o.bal += H.num(s.balance);
          }
        }
      }
      const ownerRows = Object.entries(owners).sort((a, b) => b[1].open - a[1].open);

      el.innerHTML = `
        <div class="o-page d-page">
          <header class="o-head">
            <div><h1>Dashboard</h1><p>${scope === 'mine' ? 'Your shipments, including the ones you chase payment for.' : 'Every shipment on the team.'}</p></div>
            <nav class="o-scope" aria-label="Whose shipments">
              <button class="${scope === 'mine' ? 'on' : ''}" data-scope="mine">Mine</button>
              <button class="${scope === 'all' ? 'on' : ''}" data-scope="all">Everyone</button>
            </nav>
          </header>

          <section class="d-tiles">
            <article class="d-tile">
              <h2>Open shipments</h2>
              <p class="d-big num">${link({}, open.length)}</p>
              <p class="d-meta">${rows.filter(s => s.closed).length} closed, ${rows.filter(s => s.funnel === 'rejected').length} rejected</p>
            </article>
            <article class="d-tile ${attn.length ? 'is-late' : ''}">
              <h2>Need attention</h2>
              <p class="d-big num">${link({ quick: 'attention' }, attn.length)}</p>
              <p class="d-meta">
                ${link({ quick: 'stage_days' }, `${rows.filter(s => has(s, 'stage_days')).length} stage delayed`, 'slow')}
                ${link({ quick: 'followup_due' }, `${rows.filter(s => has(s, 'followup_due')).length} follow-up due`, 'late')}
                ${link({ quick: 'payment_late' }, `${late.length} payment late`, 'late')}
              </p>
            </article>
            <article class="d-tile">
              <h2>Payment pending</h2>
              <p class="d-big num">${H.shortMoney(sum(billed, s => s.balance))}</p>
              <p class="d-meta">${billed.length} shipments with a balance. ${dueSoon.length ? `${H.shortMoney(sum(dueSoon, s => s.balance))} falls due this week.` : 'Nothing falls due this week.'}</p>
            </article>
            <article class="d-tile ${late.length ? 'is-late' : ''}">
              <h2>Payment late</h2>
              <p class="d-big num">${link({ quick: 'payment_late' }, H.shortMoney(sum(late, s => s.balance)), late.length ? 'late' : '')}</p>
              <p class="d-meta">${late.length ? `${late.length} shipment${late.length === 1 ? '' : 's'} past the due date.` : 'Nothing is past its due date.'} ${H.shortMoney(sum(collected, s => s.paidAmount))} collected this month.</p>
            </article>
          </section>

          <section class="o-card d-flow">
            <h2>Where the shipments are</h2>
            <ol>${FLOW.map(k => {
              const list = rows.filter(s => s.funnel === k);
              const slow = list.filter(s => has(s, 'stage_days')).length;
              const limit = (state.stageSla || {})[k];
              return `<li class="st-${k}"><button data-go="${esc(new URLSearchParams({ scope, stage: k }).toString())}">
                <span class="p-stage-h st-${k}"><i>${OMP.stageIcon ? OMP.stageIcon(k) : ''}</i>${esc(sentence(stageLabel(k)))}</span>
                <b class="num">${list.length}</b>
                <small>${slow ? `<em>${slow} over ${limit} day${limit === 1 ? '' : 's'}</em>` : limit ? `limit ${limit} day${limit === 1 ? '' : 's'}` : k === 'completed' ? `${list.filter(s => s.closed).length} closed, ${list.filter(s => !s.closed).length} collecting` : ''}</small>
              </button></li>`;
            }).join('')}</ol>
          </section>

          ${scope === 'all' ? `
          <section class="o-card d-owners">
            <h2>By owner</h2>
            <table>
              <thead><tr><th>Owner</th><th class="n">Open</th><th class="n">Need attention</th><th class="n">Payment late</th><th class="n">Balance pending</th></tr></thead>
              <tbody>${ownerRows.map(([n, o]) => `<tr><td>${esc(n)}</td><td class="n num">${o.open}</td><td class="n num ${o.attn ? 'late' : ''}">${o.attn}</td><td class="n num ${o.late ? 'late' : ''}">${o.late}</td><td class="n num">${H.shortMoney(o.bal)}</td></tr>`).join('')}</tbody>
            </table>
          </section>` : ''}
        </div>`;

      el.querySelectorAll('[data-scope]').forEach(b => b.onclick = () => { scope = b.dataset.scope; A.renderActive(); });
      el.querySelectorAll('[data-go]').forEach(b => b.onclick = () => {
        history.replaceState(null, '', '#list?' + b.dataset.go);
        A.setView('orders');
        window.scrollTo(0, 0);
      });
    },
  });
})();

