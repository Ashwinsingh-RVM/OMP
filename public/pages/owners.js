/* Page: Owner Performance — per-txn-team-executive workload (open/completed/overdue). */
OMP.registerPage('owners', {
  render(el, OMP) {
    const { state, helpers: H, actions: A } = OMP;
    const rows = state.shipments;
    const byOwner = {};
    rows.forEach(s => {
      const o = (s.owner || '').trim() || 'Unassigned';
      const e = byOwner[o] = byOwner[o] || { name: o, total: 0, open: 0, completed: 0, overdue: 0 };
      e.total++;
      if (s.funnel === 'completed') e.completed++;
      else if (s.funnel !== 'rejected') e.open++;
      if (s.paymentRisk === 'overdue') e.overdue++;
    });
    const list = Object.values(byOwner).sort((a, b) => b.open - a.open);
    const maxTotal = Math.max(...list.map(o => o.total), 1);

    el.innerHTML = `
      <section class="card">
        <div class="card-head"><div><h2>Owner Performance</h2><p>Workload by txn-team executive — click a row to see their shipments</p></div></div>
        <table class="data-table">
          <thead><tr><th>Owner</th><th class="num">Open</th><th class="num">Completed</th><th class="num">Overdue</th><th class="num">Total</th><th>Load</th></tr></thead>
          <tbody id="ownersBody"></tbody>
        </table>
      </section>`;

    el.querySelector('#ownersBody').innerHTML = list.map(o => `
      <tr data-owner="${H.esc(o.name)}">
        <td>${H.esc(o.name)}</td>
        <td class="num">${o.open}</td>
        <td class="num">${o.completed}</td>
        <td class="num" style="${o.overdue > 0 ? 'color:var(--bad);font-weight:700' : ''}">${o.overdue}</td>
        <td class="num">${o.total}</td>
        <td><div style="width:100px;height:8px;border-radius:4px;background:var(--surface-2);overflow:hidden"><span style="display:block;height:100%;width:${o.total / maxTotal * 100}%;background:var(--brand)"></span></div></td>
      </tr>`).join('');

    el.querySelectorAll('#ownersBody tr').forEach(tr => tr.onclick = () => {
      state.filters = { search: tr.dataset.owner.toLowerCase(), stage: '', risk: '', cause: '' };
      A.setView('crm');
    });
  }
});
