/* Page: Pipeline — stage-wise movement. Click a stage to filter the list below. */
OMP.registerPage('pipeline', {
  render(el, OMP) {
    const { state, helpers: H, actions: A } = OMP;
    const rows = state.shipments;
    const count = {}; state.stages.forEach(s => count[s.key] = 0);
    rows.forEach(s => count[s.funnel] = (count[s.funnel] || 0) + 1);
    const max = Math.max(...Object.values(count), 1);

    el.innerHTML = `
      <section class="card">
        <div class="card-head"><div><h2>Pipeline</h2><p>Click a stage to filter the shipments below</p></div>
          <button class="secondary-btn" id="pipeAll">Show all</button></div>
        <div id="pipeFunnel"></div>
      </section>
      <section class="card" style="margin-top:16px">
        <div class="card-head"><div><h2 id="pipeTitle">All shipments</h2><p>Click a shipment to open it in CRM</p></div></div>
        <div class="list cols-4" id="pipeList"></div>
      </section>`;

    el.querySelector('#pipeFunnel').innerHTML = H.funnelFlow(count, { active: state.pipelineStage, big: true });
    el.querySelectorAll('.stage-card').forEach(b => b.onclick = () => { state.pipelineStage = b.dataset.stage; A.renderActive(); });
    el.querySelector('#pipeAll').onclick = () => { state.pipelineStage = ''; A.renderActive(); };

    const list = H.ranked(state.pipelineStage ? rows.filter(s => s.funnel === state.pipelineStage) : rows);
    const label = state.pipelineStage ? (state.stages.find(s => s.key === state.pipelineStage)?.label || state.pipelineStage) : 'All shipments';
    el.querySelector('#pipeTitle').textContent = `${label} (${list.length})`;
    el.querySelector('#pipeList').innerHTML = list.map(s => `
      <button class="pipeline-item" data-id="${H.esc(s.shipmentId)}">
        <div><b>${H.esc(s.shipmentId)}</b><p style="margin-top:4px">${H.esc(s.buyer || '-')}</p>${H.payMini(s)}</div>
        <div class="pipe-side">${H.stagePill(s)} ${H.docChip(s)} ${H.paymentPill(s)} ${H.proofChip(s)}</div>
      </button>`).join('') || '<p class="sub" style="padding:8px">No shipments in this stage.</p>';
    el.querySelectorAll('.pipeline-item').forEach(b => b.onclick = () => A.openInCrm(b.dataset.id));
  }
});
