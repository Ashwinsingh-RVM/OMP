/* Page: Stage Aging — which open shipments have sat longest in their current stage. */
OMP.registerPage('aging', {
  render(el, OMP) {
    const { state, helpers: H, actions: A } = OMP;
    const isOpen = s => s.funnel !== 'completed' && s.funnel !== 'rejected';
    const open = state.shipments.filter(isOpen);
    const rows = [...open].sort((a, b) => H.num(b.stageAge) - H.num(a.stageAge));

    el.innerHTML = `
      <section class="card">
        <div class="card-head"><div><h2>Stage Aging</h2><p>Open shipments sorted by time in current stage — oldest first</p></div>
          <select id="agingStageFilter"><option value="">All stages</option>${state.stages.filter(s => s.key !== 'completed' && s.key !== 'rejected').map(s => `<option value="${s.key}">${s.label}</option>`).join('')}</select>
        </div>
        <div class="shipment-list" id="agingList"></div>
      </section>`;

    const filterSel = el.querySelector('#agingStageFilter');
    filterSel.onchange = () => renderList(filterSel.value);
    renderList('');

    function renderList(stageKey) {
      const list = stageKey ? rows.filter(s => s.funnel === stageKey) : rows;
      el.querySelector('#agingList').innerHTML = list.map(s => `
        <button class="shipment-item" data-id="${H.esc(s.shipmentId)}">
          <div class="shipment-top"><span class="shipment-id">${H.esc(s.shipmentId)}</span>${H.stagePill(s)}</div>
          <div class="shipment-title">${H.esc(s.buyer || '-')}</div>
          <div class="tiny-row"><span class="chip info">${H.num(s.stageAge)}d in stage</span> ${H.reasonChip(s)}</div>
          <p class="sub" style="margin-top:6px">${H.esc(s.owner || 'Unassigned')}</p>
        </button>`).join('') || '<p class="sub" style="padding:8px">No open shipments in this stage.</p>';
      el.querySelectorAll('.shipment-item').forEach(b => b.onclick = () => A.openInCrm(b.dataset.id));
    }
  }
});
