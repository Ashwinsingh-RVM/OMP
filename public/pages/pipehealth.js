/* Page: Pipeline Health — current stage distribution + dispatch-month outcome trend. */
OMP.registerPage('pipehealth', {
  render(el, OMP) {
    const { state, helpers: H } = OMP;
    const rows = state.shipments;
    const count = {}; state.stages.forEach(s => count[s.key] = 0);
    rows.forEach(s => count[s.funnel] = (count[s.funnel] || 0) + 1);

    const byMonth = new Map();
    rows.forEach(s => {
      const m = s.month || 'Unknown';
      const e = byMonth.get(m) || { month: m, total: 0, completed: 0, rejected: 0, open: 0 };
      e.total++;
      if (s.funnel === 'completed') e.completed++;
      else if (s.funnel === 'rejected') e.rejected++;
      else e.open++;
      byMonth.set(m, e);
    });
    const months = [...byMonth.values()];
    const maxMonth = Math.max(...months.map(m => m.total), 1);

    el.innerHTML = `
      <section class="card">
        <div class="card-head"><div><h2>Pipeline Health</h2><p>Current stage distribution + dispatch-month outcomes</p></div></div>
        <div id="phFunnel"></div>
      </section>
      <section class="card" style="margin-top:16px">
        <div class="card-head"><div><h2>Dispatch month → outcome</h2><p>Completed / open / rejected, by dispatch month</p></div></div>
        <div id="phMonths" style="padding:14px 16px"></div>
      </section>`;

    el.querySelector('#phFunnel').innerHTML = H.funnelFlow(count, { big: true });

    el.querySelector('#phMonths').innerHTML = months.map(m => `
      <div style="display:grid;grid-template-columns:80px 1fr 140px;gap:12px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line-soft)">
        <span style="font-weight:600">${H.esc(m.month)}</span>
        <div style="display:flex;height:20px;border-radius:5px;overflow:hidden;background:var(--surface-2)">
          <span style="width:${m.completed / maxMonth * 100}%;background:var(--brand)" title="${m.completed} completed"></span>
          <span style="width:${m.open / maxMonth * 100}%;background:var(--gold)" title="${m.open} open"></span>
          <span style="width:${m.rejected / maxMonth * 100}%;background:var(--bad)" title="${m.rejected} rejected"></span>
        </div>
        <span class="sub num" style="text-align:right">${m.total} total &middot; ${m.completed} done</span>
      </div>`).join('') || '<p class="sub">No dispatch data.</p>';
  }
});
