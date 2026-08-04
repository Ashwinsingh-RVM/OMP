/* Page: Overview — the at-a-glance control tower.
   KPI console + clickable pipeline snapshot + today's follow-ups + priority queue. */
OMP.registerPage('overview', {
  render(el, OMP) {
    const { state, helpers: H, actions: A } = OMP;
    const rows = H.myShipments(); // personal view — your shipments (admin = all)
    const open = rows.filter(s => s.funnel !== 'completed' && s.funnel !== 'rejected');
    const completed = rows.filter(s => s.funnel === 'completed');
    const due = rows.filter(H.isDue);
    const blocked = rows.filter(H.needs);
    const payShip = rows.filter(s => Number(s.balance || 0) > 1 && s.funnel !== 'rejected');
    const paySum = payShip.reduce((a, s) => a + H.num(s.balance), 0);
    const proof = rows.filter(s => s.paidProofPending).length;
    const openDocs = open.filter(s => s.requiredDocs.length);
    const reqSum = openDocs.reduce((a, s) => a + (s.docStats?.required || 0), 0);
    const verSum = openDocs.reduce((a, s) => a + (s.docStats?.verified || 0), 0);
    const vpct = reqSum ? Math.round(verSum / reqSum * 100) : 100;
    const donePct = rows.length ? Math.round(completed.length / rows.length * 100) : 0;

    const kpis = [
      { tone: 'today', k: 'To clear today', v: due.length, meta: 'follow-ups', note: due.length ? 'Act on each, then log a remark' : 'Nothing due — good' },
      { tone: 'block', k: 'Blocked', v: blocked.length, meta: 'need action', note: 'Docs, owner, payment, QC/DN' },
      { tone: 'docs', k: 'Docs verified', v: vpct, unit: '%', meta: `${openDocs.length - openDocs.filter(s => s.missingDocs.length).length}/${openDocs.length} clear`, note: `${openDocs.reduce((a, s) => a + s.missingDocs.length, 0)} docs pending`, bar: vpct },
      { tone: 'money', k: 'Payment pending', v: H.shortMoney(paySum), meta: `${payShip.length} shipments`, note: proof ? `${proof} paid · proof not uploaded` : 'Balance open in scope' },
      { tone: 'done', k: 'Completed', v: completed.length, unit: `/${rows.length}`, meta: `${donePct}% cleared`, note: 'Closed in your scope' },
    ];

    el.innerHTML = `
      <div class="kpi-strip">${kpis.map(kpiCard).join('')}</div>
      <div class="stack">
        <section class="card">
          <div class="card-head"><div><h2>Pipeline snapshot</h2><p>Click a stage to open it in Pipeline</p></div></div>
          <div id="ovFunnel"></div>
        </section>
        <div class="grid-2">
          <section class="card">
            <div class="card-head"><div><h2>Today’s work</h2><p>Follow-ups due today or overdue</p></div></div>
            <div class="list" id="ovToday"></div>
          </section>
          <section class="card">
            <div class="card-head"><div><h2>Priority queue</h2><p>Clear these first</p></div></div>
            <div class="list" id="ovPriority"></div>
          </section>
        </div>
      </div>`;

    function kpiCard(c) {
      return `<article class="kpi ${c.tone}">
        <div class="kpi-head"><span class="kpi-k">${c.k}</span><span class="kpi-meta">${c.meta || ''}</span></div>
        <div class="kpi-v">${c.v}${c.unit ? `<small>${c.unit}</small>` : ''}</div>
        ${c.bar != null ? `<div class="mini-bar"><span style="width:${c.bar}%"></span></div>` : ''}
        <div class="kpi-note">${c.note || ''}</div>
      </article>`;
    }

    // funnel — pastel emoji flow with arrows
    el.querySelector('#ovFunnel').innerHTML = H.funnelFlow(H.stageCounts(rows));
    el.querySelectorAll('.stage-card').forEach(b => b.onclick = () => { state.pipelineStage = b.dataset.stage; A.setView('pipeline'); });

    // lists
    fillList(el.querySelector('#ovToday'), H.ranked(due).slice(0, 8), s => H.actionReason(s), 'No follow-ups due today.');
    fillList(el.querySelector('#ovPriority'), H.ranked(blocked).slice(0, 8), s => H.actionReason(s), 'No open blockers — clean.');

    function fillList(node, list, reasonFn, empty) {
      node.innerHTML = list.map(s => {
        const r = reasonFn(s);
        return `<button class="action-card" data-id="${H.esc(s.shipmentId)}">
          <div class="action-top"><b>${H.esc(s.shipmentId)}</b><span class="badge ${r.kind}">${r.short}</span></div>
          <h3>${H.esc(r.title)}</h3><p>${H.esc(r.body)}</p>
          <p class="sub">${H.esc(s.buyer || '-')} · ${H.esc(s.owner || 'Unassigned')} · ${H.esc(s.stageLabel)}</p>
          ${H.payMini(s)}
        </button>`;
      }).join('') || `<p class="sub" style="padding:8px">${empty}</p>`;
      node.querySelectorAll('.action-card').forEach(b => b.onclick = () => A.openInCrm(b.dataset.id));
    }
  }
});
