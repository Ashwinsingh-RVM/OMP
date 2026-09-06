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
        <div class="card-head"><div><h2 id="pipeTitle">All shipments</h2><p>Click a row to open it in CRM</p></div></div>
        <div class="data-table-wrap">
          <table class="data-table">
            <thead><tr>
              <th>Shipment</th><th>Buyer</th><th>Owner</th><th>Stage</th>
              <th class="num">Days</th><th class="num">Balance</th><th>Payment</th>
            </tr></thead>
            <tbody id="pipeList"></tbody>
          </table>
        </div>
      </section>`;

    el.querySelector('#pipeFunnel').innerHTML = H.funnelFlow(count, { active: state.pipelineStage, big: true });
    el.querySelectorAll('.stage-card').forEach(b => b.onclick = () => { state.pipelineStage = b.dataset.stage; A.renderActive(); });
    el.querySelector('#pipeAll').onclick = () => { state.pipelineStage = ''; A.renderActive(); };

    const list = H.ranked(state.pipelineStage ? rows.filter(s => s.funnel === state.pipelineStage) : rows);
    const label = state.pipelineStage ? (state.stages.find(s => s.key === state.pipelineStage)?.label || state.pipelineStage) : 'All shipments';
    el.querySelector('#pipeTitle').textContent = `${label} (${list.length})`;
    el.querySelector('#pipeList').innerHTML = list.map(s => `
      <tr data-id="${H.esc(s.shipmentId)}">
        <td class="id">${H.esc(s.shipmentId)}</td>
        <td class="buyer">${H.esc(s.buyer || '-')}</td>
        <td>${H.esc(s.owner || 'Unassigned')}</td>
        <td>${H.stagePill(s)}</td>
        <td class="num">${H.num(s.stageAge)}d</td>
        <td class="num">${H.shortMoney(s.balance)}</td>
        <td>${H.paymentPill(s)}</td>
      </tr>`).join('') || '<tr><td colspan="7" class="sub" style="padding:12px">No shipments in this stage.</td></tr>';
    el.querySelectorAll('#pipeList tr[data-id]').forEach(tr => tr.onclick = () => A.openInCrm(tr.dataset.id));
  }
});
