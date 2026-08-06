/* Page: My Work — the associate's own queue + performance snapshot. */
OMP.registerPage('work', {
  render(el, OMP) {
    const { state, helpers: H, actions: A } = OMP;
    const rows = H.myShipments(); // My Work = shipments assigned to me (admin = all)
    const due = H.ranked(rows.filter(H.isDue));
    const blocked = H.ranked(rows.filter(H.needs));

    el.innerHTML = `
      <section class="card">
        <div class="card-head"><div><h2>My performance snapshot</h2><p>Shipment load, completion and stage dwell</p></div></div>
        <div id="wkStats"></div>
      </section>
      <div class="grid-2" style="margin-top:16px">
        <section class="card">
          <div class="card-head"><div><h2>Today’s work</h2><p>${due.length} follow-up${due.length === 1 ? '' : 's'} due or overdue</p></div></div>
          <div class="list cols-2" id="wkToday"></div>
        </section>
        <section class="card">
          <div class="card-head"><div><h2>Open priority</h2><p>${blocked.length} case${blocked.length === 1 ? '' : 's'} to unblock</p></div></div>
          <div class="list cols-2" id="wkPriority"></div>
        </section>
      </div>`;

    card(el.querySelector('#wkToday'), due, 'No follow-ups due today.');
    card(el.querySelector('#wkPriority'), blocked, 'No open blockers.');

    function card(node, list, empty) {
      node.innerHTML = list.map(s => {
        const r = H.actionReason(s);
        return `<button class="action-card" data-id="${H.esc(s.shipmentId)}">
          <div class="action-top"><b>${H.esc(s.shipmentId)}</b><span class="badge ${r.kind}">${r.short}</span></div>
          <h3>${H.esc(r.title)}</h3><p>${H.esc(r.body)}</p>
          <div class="tiny-row">${H.docChip(s)} ${H.reasonChip(s)} ${H.proofChip(s)}</div>
          <p class="sub" style="margin-top:6px">${H.esc(s.buyer || '-')} · ${H.esc(s.owner || 'Unassigned')} · ${H.esc(s.stageLabel)}</p>
          ${H.payMini(s)}
        </button>`;
      }).join('') || `<p class="sub" style="padding:8px">${empty}</p>`;
      node.querySelectorAll('.action-card').forEach(b => b.onclick = () => A.openInCrm(b.dataset.id));
    }

    // performance
    const completed = rows.filter(s => s.funnel === 'completed');
    const open = rows.filter(s => s.funnel !== 'completed' && s.funnel !== 'rejected');
    const pending = rows.reduce((a, s) => a + H.num(s.balance), 0);
    const stageRows = state.stages.map(st => {
      const list = rows.filter(s => s.funnel === st.key);
      return { label: st.label, count: list.length, age: H.avg(list.map(s => Number(s.dispatchAge || 0))) };
    }).filter(x => x.count > 0);
    const metrics = [
      ['Total shipments', rows.length], ['Open', open.length], ['Completed', completed.length],
      ['Pending payment', H.shortMoney(pending)],
      ['Avg completion', H.avg(completed.map(s => Number(s.dispatchAge || 0))) + 'd'],
      ['Avg open age', H.avg(open.map(s => Number(s.dispatchAge || 0))) + 'd'],
    ];
    el.querySelector('#wkStats').innerHTML = `
      <div class="assoc-grid">${metrics.map(([k, v]) => `<div class="assoc-metric"><span>${k}</span><b>${v}</b></div>`).join('')}</div>
      <div class="dwell-list">${stageRows.map(s => `<div class="dwell-row"><span>${s.label}</span><b>${s.count} shipments</b><em>${s.age}d avg dwell</em></div>`).join('') || '<p class="sub">No active stage data.</p>'}</div>
      <p class="sub dwell-note">Dwell = estimated from dispatch age (exact stage timestamps aren’t in the source yet). It sharpens as stages get updated in CRM.</p>`;
  }
});
