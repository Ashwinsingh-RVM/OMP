/* Page: Shipment CRM — the daily work surface.
   Left: filterable shipment list. Right: cockpit to drive one shipment to close.
   Owns: reason dropdown, document verification, stage stepper, follow-up, timeline. */
OMP.registerPage('crm', {
  render(el, OMP) {
    const { state, helpers: H, actions: A } = OMP;
    const esc = H.esc;
    const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    function parseD(v) {
      if (!v) return null; const s = String(v).trim(); if (!s || s.toLowerCase() === 'na') return null;
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return new Date(s.slice(0, 10) + 'T00:00:00');
      const m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/); if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
      const d = new Date(s); return isNaN(d) ? null : d;
    }
    const fmtD = d => d ? `${String(d.getDate()).padStart(2, '0')} ${MON3[d.getMonth()]} ${String(d.getFullYear()).slice(2)}` : '—';
    const pcell = (l, v) => `<div class="pcell"><span>${l}</span><b>${v}</b></div>`;

    el.innerHTML = `
      <div class="crm-layout">
        <aside class="card crm-list">
          <div class="card-head"><div><h2>Shipments</h2><p id="crmCount">0 records</p></div></div>
          <div class="filters">
            <input id="crmSearch" type="search" placeholder="Search shipment, buyer, seller, POC" />
            <div class="filter-row">
              <select id="crmStage"></select>
              <select id="crmRisk">
                <option value="">All shipments</option>
                <option value="mine">My shipments</option>
                <option value="needs">Needs action</option>
                <option value="docs">Docs pending</option>
                <option value="proof">Paid · proof pending</option>
                <option value="overdue">Payment overdue</option>
                <option value="unassigned">Owner missing</option>
              </select>
            </div>
          </div>
          <div class="shipment-list" id="crmList"></div>
        </aside>
        <section class="card" id="crmMain"></section>
      </div>`;

    // filters
    const stageSel = el.querySelector('#crmStage');
    stageSel.innerHTML = '<option value="">All stages</option>' + state.stages.map(s => `<option value="${s.key}">${s.label}</option>`).join('');
    stageSel.value = state.filters.stage;
    el.querySelector('#crmRisk').value = state.filters.risk;
    const search = el.querySelector('#crmSearch');
    search.value = state.filters.search;

    const listEl = el.querySelector('#crmList');
    const countEl = el.querySelector('#crmCount');
    function renderList() {
      const rows = H.ranked(H.filtered());
      countEl.textContent = `${rows.length} record${rows.length === 1 ? '' : 's'}`;
      listEl.innerHTML = rows.map(shipmentCard).join('') || '<p class="sub" style="padding:8px">No shipments match filters.</p>';
      listEl.querySelectorAll('.shipment-item').forEach(b => b.onclick = () => A.selectShipment(b.dataset.id));
    }
    function shipmentCard(s) {
      const r = H.actionReason(s);
      return `<button class="shipment-item ${s.shipmentId === state.selectedId ? 'active' : ''}" data-id="${esc(s.shipmentId)}">
        <div class="shipment-top"><span class="shipment-id">${esc(s.shipmentId)}</span>${H.stagePill(s)}</div>
        <div class="shipment-title">${esc(s.buyer || '-')}</div>
        <div class="tiny-row">${s.canEdit ? '' : '<span class="chip neutral" title="Read-only — not assigned to you">🔒</span>'}${H.paymentPill(s)} ${H.docChip(s)} ${H.reasonChip(s)} ${H.proofChip(s)} ${s.followUp ? `<span class="chip ${H.isDue(s) ? 'bad' : 'info'}">FU ${esc(s.followUp.dueDate)}</span>` : ''}</div>
        ${H.payMini(s)}
      </button>`;
    }
    search.oninput = e => { state.filters.search = e.target.value.toLowerCase(); renderList(); };
    stageSel.onchange = e => { state.filters.stage = e.target.value; renderList(); };
    el.querySelector('#crmRisk').onchange = e => { state.filters.risk = e.target.value; renderList(); };
    renderList();

    // cockpit
    renderCockpit(el.querySelector('#crmMain'));

    function renderCockpit(main) {
      const s = state.selected;
      if (!s) { main.innerHTML = '<div class="empty-state"><h2>Select a shipment</h2><p>Pick one from the left to update stage, reason, docs, payment and follow-up.</p></div>'; return; }
      const r = H.actionReason(s);
      const ro = !s.canEdit;
      const money = k => H.shortMoney(s[k]);
      main.innerHTML = `
        <div class="selected-head">
          <div>
            <div class="tiny-row" style="margin:0">${H.stagePill(s)} ${H.reasonChip(s)} ${H.proofChip(s)}</div>
            <h2>${esc(s.shipmentId)}</h2>
            <div class="selected-sub">${esc(s.seller || '—')} → ${esc(s.buyer || '—')}</div>
            ${H.payMini(s, true)}
          </div>
          <div class="head-actions">
            ${s.followUp ? `<span class="badge ${H.isDue(s) ? 'bad' : 'info'}">Follow-up ${esc(s.followUp.dueDate)}</span>` : ''}
            ${H.paymentPill(s)}
          </div>
        </div>
        ${ro ? `<div class="ro-banner">🔒 Read-only — owned by <b>${esc(s.owner || 'another associate')}</b>. Only they can update this shipment.</div>` : ''}
        <div style="padding:14px 16px;border-bottom:1px solid var(--line-soft)">${stepper(s)}</div>
        <div class="detail-grid">
          ${detail('Owner', s.owner || 'Unassigned')}
          ${detail('Stage', s.stageLabel)}
          ${detail('Paid', money('paidAmount'), true)}
          ${detail('Balance', money('balance'), true)}
          ${detail('Net Payable', H.shortMoney(s.netPayable || s.total), true)}
          ${detail('Follow-up', s.followUp?.dueDate || 'Not set')}
        </div>
        <div class="crm-grid">
          ${paymentBox(s)}
          <div class="section-box">
            <div class="section-title"><h3>Update Stage &amp; Reason</h3><span class="badge ${r.kind}">${r.short}</span></div>
            <div class="section-body">
              <div class="form-row">
                <select id="stageUpdate">${state.stages.map(st => `<option value="${st.key}" ${st.key === s.funnel ? 'selected' : ''}>${st.label}</option>`).join('')}</select>
                <button class="primary-btn" id="saveStage">Save</button>
              </div>
              <select id="stageReason">${H.REASONS.map(([v, l]) => `<option value="${v}" ${v === (s.blockReason || '') ? 'selected' : ''}>${l}</option>`).join('')}</select>
              <textarea id="stageNote" placeholder="Remarks — what happened, next step"></textarea>
              <div class="form-row">
                <input id="ownerUpdate" type="text" value="${esc(s.controlPoc || '')}" placeholder="Owner / Control POC" />
                <button class="secondary-btn" id="saveOwner">Set owner</button>
              </div>
            </div>
          </div>
          <div class="section-box">
            <div class="section-title"><h3>Schedule Follow-up</h3><span class="badge ${s.followUp ? (H.isDue(s) ? 'bad' : 'info') : 'warn'}">${s.followUp ? esc(s.followUp.dueDate) : 'not set'}</span></div>
            <div class="section-body">
              <div class="form-row"><input id="fuDate" type="date" value="${s.followUp?.dueDate || H.today()}" /><button class="primary-btn" id="saveFu">Set</button></div>
              <textarea id="fuNote" placeholder="Follow-up remark">${esc(s.followUp?.note || '')}</textarea>
              <button class="secondary-btn" id="fuDone">Mark done</button>
            </div>
          </div>
          ${docGate(s)}
          <div class="section-box span-2 collapsed">
            <div class="section-title"><h3>Timeline</h3><span class="badge info">${state.timeline.length}</span></div>
            <div class="section-body">
              <div class="timeline">${state.timeline.map(H.eventHtml).join('') || '<p class="sub">No updates yet.</p>'}</div>
              <div class="form-row"><input id="genNote" type="text" placeholder="Add a remark" /><button class="secondary-btn" id="saveNote">Add</button></div>
            </div>
          </div>
        </div>`;

      // edit bindings — only when the signed-in associate owns this shipment
      if (!ro) {
        main.querySelector('#saveStage').onclick = () => A.postUpdate({ type: 'stage', value: main.querySelector('#stageUpdate').value, reason: main.querySelector('#stageReason').value, note: main.querySelector('#stageNote').value });
        main.querySelector('#saveOwner').onclick = () => { const v = main.querySelector('#ownerUpdate').value.trim(); if (v) A.postUpdate({ type: 'owner', value: v, note: 'Owner updated' }); };
        main.querySelector('#saveNote').onclick = () => { const v = main.querySelector('#genNote').value.trim(); if (v) A.postUpdate({ type: 'note', value: v, note: 'Remark' }); };
        main.querySelector('#saveFu').onclick = () => A.postUpdate({ type: 'followup', value: 'scheduled', dueDate: main.querySelector('#fuDate').value, note: main.querySelector('#fuNote').value, status: 'open' });
        main.querySelector('#fuDone').onclick = () => A.postUpdate({ type: 'followup', value: 'done', dueDate: H.today(), note: main.querySelector('#fuNote').value || 'Follow-up completed', status: 'done' });
        main.querySelectorAll('.doc-select').forEach(x => x.onchange = () => A.postUpdate({ type: 'doc', key: x.dataset.key, value: x.value, note: `${state.docs[x.dataset.key] || x.dataset.key} → ${x.value}` }));
      } else {
        main.querySelectorAll('.section-body button, .section-body input, .section-body select, .section-body textarea').forEach(x => x.disabled = true);
      }
      // collapsible sections — click header (not a control) to fold
      main.querySelectorAll('.section-title').forEach(t => t.onclick = e => {
        if (e.target.closest('button, select, input, textarea, a')) return;
        t.parentElement.classList.toggle('collapsed');
      });
    }

    function detail(label, value, isNum) {
      return `<div class="detail ${isNum ? 'num' : ''}"><span>${label}</span><b>${esc(value || '-')}</b></div>`;
    }

    function paymentBox(s) {
      const due = parseD(s.dueDate), inv = parseD(s.invoiceDate);
      const bal = H.num(s.balance), paid = H.num(s.paidAmount);
      const now = Date.now();
      const overdue = due && bal > 1 ? Math.floor((now - due) / 86400000) : null;
      const since = inv && bal > 1 ? Math.floor((now - inv) / 86400000) : null;
      const badge = s.paymentDerived === 'paid' ? '<span class="badge ok">Cleared</span>' : s.paymentRisk === 'overdue' ? '<span class="badge bad">Overdue</span>' : s.paymentDerived === 'partial' ? '<span class="badge warn">Partial</span>' : '<span class="badge neutral">Pending</span>';
      const overdueTxt = bal <= 1 ? 'Cleared' : (overdue != null && overdue > 0 ? `<span style="color:var(--bad)">${overdue} days late</span>` : (due ? 'On time' : '—'));
      return `<div class="section-box span-2">
        <div class="section-title"><h3>Payment</h3>${badge}</div>
        <div class="section-body">
          <div class="pay-grid">
            ${pcell('Invoice date', fmtD(inv))}
            ${pcell('Terms', esc(s.paymentTerms || '—'))}
            ${pcell('Due date', fmtD(due))}
            ${pcell('Overdue', overdueTxt)}
            ${pcell('Pending since', since != null ? since + ' days' : '—')}
            ${pcell('Paid', H.shortMoney(paid))}
            ${pcell('Pending', `<span style="color:${bal > 1 ? 'var(--bad)' : 'var(--ok)'}">${H.shortMoney(bal)}</span>`)}
          </div>
          ${H.payMini(s, true)}
          ${s.paidProofPending ? '<p class="docv-note" style="color:var(--bad)">Paid but UTR / payment advice not uploaded in system.</p>' : ''}
        </div>
      </div>`;
    }

    function stepper(s) {
      const order = state.stages.filter(st => st.key !== 'rejected');
      const cur = state.stages.findIndex(st => st.key === s.funnel);
      const rejected = s.funnel === 'rejected';
      return `<div class="stepper">${order.map((st, i) => {
        const idx = state.stages.findIndex(x => x.key === st.key);
        let cls = idx < cur ? 'done' : idx === cur ? 'current' : '';
        if (rejected && i === order.length - 1) cls = '';
        return `<div class="step ${cls}"><div class="pin">${i + 1}</div><div class="pin-label">${esc(st.label)}</div></div>`;
      }).join('')}${rejected ? '<div class="step rejected"><div class="pin">X</div><div class="pin-label">Rejected</div></div>' : ''}</div>`;
    }

    function docGate(s) {
      const d = s.docStats || { required: 0, verified: 0, ok: 0, pending: 0, missing: 0, na: 0, pct: 100 };
      const req = new Set(s.requiredDocs || []);
      const groups = H.DOC_GROUPS.map(g => {
        const items = g.keys.map(k => ({ k, label: state.docs[k] || k, val: s.docs[k] || 'missing', req: req.has(k) }));
        const gReq = items.filter(i => i.req);
        const gVer = gReq.filter(i => i.val === 'ok' || i.val === 'na').length;
        return { ...g, items, gReqN: gReq.length, gVer };
      }).filter(g => g.items.length);
      const rcls = d.missing ? 'bad' : d.pending ? 'warn' : 'ok';
      const rows = groups.map(g => `
        <div class="doc-group">
          <div class="dg-head"><span>${g.label}</span>${g.gReqN ? `<em class="${g.gVer === g.gReqN ? 'ok' : 'pend'}">${g.gVer}/${g.gReqN}</em>` : '<em class="opt">later</em>'}</div>
          ${g.items.map(docRow).join('')}
        </div>`).join('');
      return `<div class="section-box span-2 collapsed">
        <div class="section-title"><h3>Document Verification</h3><span class="doc-ratio ${rcls}">${d.verified}<i>/${d.required}</i> verified</span></div>
        <div class="section-body">
          <div class="docv-summary">
            <div class="docv-bar ${rcls}"><span style="width:${d.pct}%"></span></div>
            <div class="docv-legend"><span class="dl ok">${d.ok} OK</span><span class="dl pend">${d.pending} pending</span><span class="dl miss">${d.missing} missing</span><span class="dl">${d.na} NA</span></div>
          </div>
          <div class="doc-groups">${rows}</div>
          <p class="docv-note"><i class="reqdot">●</i> Required to clear <b>${esc(s.stageLabel)}</b>. Tap a status to verify — no file upload, status only.</p>
        </div>
      </div>`;
    }
    function docRow(i) {
      return `<div class="doc-row ${i.req ? 'req' : 'opt'}">
        <span class="doc-name">${i.req ? '<i class="reqdot">●</i>' : ''}${esc(i.label)}</span>
        <select class="doc-select v-${i.val}" data-key="${i.k}" title="Set document status">
          ${OMP.helpers.DOC_STATES.map(([v, l]) => `<option value="${v}" ${v === i.val ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>`;
    }
  }
});
