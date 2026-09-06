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
          <div class="card-head"><div><h2>Shipments</h2><p id="crmCount">0 records</p></div><button class="primary-btn" id="newShipmentBtn">+ New</button></div>
          <div class="section-box collapsed" id="newShipmentBox" style="margin:10px;border-radius:var(--r-sm)">
            <div class="section-title"><h3>New Shipment</h3><span class="badge neutral">only Shipment ID is auto</span></div>
            <div class="section-body">
              <p class="sub" style="margin:-2px 0 2px">Everything below is entered manually — same as any existing shipment.</p>
              <input id="nsBuyer" type="text" placeholder="Buyer (required)" />
              <input id="nsSeller" type="text" placeholder="Seller" />
              <input id="nsMaterial" type="text" placeholder="Material" />
              <div class="form-row"><input id="nsQty" type="number" placeholder="Qty (kg)" /><input id="nsValue" type="number" placeholder="Material value (₹)" /></div>
              <input id="nsControlPoc" type="text" placeholder="Owner / Control POC" list="ownerOptionsListNew" />
              <datalist id="ownerOptionsListNew">${(state.ownerOptions||[]).map(n=>`<option value="${esc(n)}">`).join('')}</datalist>
              <button class="primary-btn" id="nsCreate">Create shipment</button>
              <p class="sub" id="nsError" style="color:var(--bad);display:none"></p>
            </div>
          </div>
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

    // New Shipment — only the ID is auto-generated, everything else is typed in here
    el.querySelector('#newShipmentBtn').onclick = () => el.querySelector('#newShipmentBox').classList.toggle('collapsed');
    el.querySelector('#nsCreate').onclick = async () => {
      const errEl = el.querySelector('#nsError');
      errEl.style.display = 'none';
      const buyer = el.querySelector('#nsBuyer').value.trim();
      if (!buyer) { errEl.textContent = 'Buyer is required.'; errEl.style.display = 'block'; return; }
      try {
        const res = await A.api('/api/shipments', {
          method: 'POST',
          body: JSON.stringify({
            buyer,
            seller: el.querySelector('#nsSeller').value.trim(),
            material: el.querySelector('#nsMaterial').value.trim(),
            qtyKg: el.querySelector('#nsQty').value,
            materialValue: el.querySelector('#nsValue').value,
            controlPoc: el.querySelector('#nsControlPoc').value.trim(),
          }),
        });
        await A.loadBootstrap(state.user.email);
        await A.selectShipment(res.shipmentId, false);
        A.renderActive();
        A.toast(`Created ${res.shipmentId}`);
      } catch (e) {
        errEl.textContent = 'Could not create shipment — try again.'; errEl.style.display = 'block';
      }
    };

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
        <div class="cockpit-tabs" id="cockpitTabs">
          <button class="ck-tab active" data-g="stage">Stage &amp; Reason</button>
          <button class="ck-tab" data-g="qtyfin">Quantity &amp; Finance</button>
          <button class="ck-tab" data-g="docs">Docs</button>
          <button class="ck-tab" data-g="people">People &amp; Contact</button>
          <button class="ck-tab" data-g="timeline">Timeline</button>
        </div>
        <div class="crm-grid">

          <div class="ck-group" data-group="stage">
            <div class="section-box">
              <div class="section-title"><h3>Update Stage &amp; Reason</h3><span class="badge ${r.kind}">${r.short}</span></div>
              <div class="section-body">
                <select id="stageUpdate">${state.stages.map(st => `<option value="${st.key}" ${st.key === s.funnel ? 'selected' : ''}>${st.label}</option>`).join('')}</select>
                <select id="stageReason">${H.REASONS.map(([v, l]) => `<option value="${v}" ${v === (s.blockReason || '') ? 'selected' : ''}>${l}</option>`).join('')}</select>
                <textarea id="stageNote" placeholder="Remarks — what happened, next step"></textarea>
                <select id="issueType"><option value="">— why stuck (issue tag) —</option>${H.ISSUE_TYPES.filter(([v])=>v).map(([v, l]) => `<option value="${v}" ${v === (s.issueType || '') ? 'selected' : ''}>${l}</option>`).join('')}</select>
              </div>
            </div>
            <div class="section-box">
              <div class="section-title"><h3>Schedule Follow-up</h3><span class="badge ${s.followUp ? (H.isDue(s) ? 'bad' : 'info') : 'warn'}">${s.followUp ? esc(s.followUp.dueDate) : 'not set'}</span></div>
              <div class="section-body">
                <input id="fuDate" type="date" value="${s.followUp?.dueDate || H.today()}" />
                <textarea id="fuNote" placeholder="Follow-up remark">${esc(s.followUp?.note || '')}</textarea>
                <button class="secondary-btn" id="fuDone">Mark done now</button>
              </div>
            </div>
          </div>

          <div class="ck-group" data-group="qtyfin" hidden>
            ${qtyBox(s)}
            ${paymentBox(s)}
            ${marginBox(s)}
          </div>

          <div class="ck-group" data-group="docs" hidden>
            ${docGate(s)}
          </div>

          <div class="ck-group" data-group="people" hidden>
            <div class="section-box">
              <div class="section-title"><h3>Owner</h3><span class="badge neutral">txn team exec</span></div>
              <div class="section-body">
                <input id="ownerUpdate" type="text" value="${esc(s.controlPoc || '')}" placeholder="Owner / Control POC" list="ownerOptionsList" />
                <datalist id="ownerOptionsList">${(state.ownerOptions||[]).map(n=>`<option value="${esc(n)}">`).join('')}</datalist>
              </div>
            </div>
            ${pocLogBox(s)}
          </div>

          <div class="ck-group" data-group="timeline" hidden>
            <div class="section-box span-2">
              <div class="section-title" style="cursor:default"><h3>Timeline</h3><span class="badge info">${state.timeline.length}</span></div>
              <div class="section-body">
                <div class="timeline">${state.timeline.map(H.eventHtml).join('') || '<p class="sub">No updates yet.</p>'}</div>
                <div class="form-row"><input id="genNote" type="text" placeholder="Add a remark" /><button class="secondary-btn" id="saveNote">Add</button></div>
              </div>
            </div>
          </div>

        </div>
        <div class="save-footer">
          <span class="sub" id="crmSaveStatus">No unsaved changes</span>
          <span style="display:flex;align-items:center;gap:10px">
            <span class="sub" id="crmSaveToast" style="color:var(--ok);display:none">Saved ✓</span>
            <button class="primary-btn" id="saveAll">Save changes</button>
          </span>
        </div>`;

      // edit bindings — only when the signed-in associate owns this shipment
      if (!ro) {
        main.querySelector('#stageUpdate').onchange = e => {
          const reasonSel = main.querySelector('#stageReason');
          const list = e.target.value === 'rejected' ? H.REJECTION_REASONS : H.REASONS;
          reasonSel.innerHTML = list.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
          markDirty();
        };
        main.querySelector('#saveNote').onclick = () => { const v = main.querySelector('#genNote').value.trim(); if (v) A.postUpdate({ type: 'note', value: v, note: 'Remark' }); };
        main.querySelector('#fuDone').onclick = () => A.postUpdate({ type: 'followup', value: 'done', dueDate: H.today(), note: main.querySelector('#fuNote').value || 'Follow-up completed', status: 'done' });
        main.querySelectorAll('.doc-select').forEach(x => x.onchange = () => A.postUpdate({ type: 'doc', key: x.dataset.key, value: x.value, note: `${state.docs[x.dataset.key] || x.dataset.key} → ${x.value}` }));

        // one consolidated Save for every editable field above (stage/reason/remarks,
        // issue tag, owner, qty, TDS, invoice date/terms/due date, follow-up date+note)
        function markDirty() {
          const st = main.querySelector('#crmSaveStatus'), tst = main.querySelector('#crmSaveToast');
          if (st) { st.textContent = 'Unsaved changes'; st.style.color = 'var(--warn)'; }
          if (tst) tst.style.display = 'none';
        }
        main.querySelectorAll('.crm-grid input, .crm-grid select, .crm-grid textarea').forEach(x => {
          if (['genNote', 'buyerPocNote', 'sellerPocNote'].includes(x.id)) return; // these have their own Add/Log action
          x.addEventListener('input', markDirty); x.addEventListener('change', markDirty);
        });

        // Margin % ↔ amount, bidirectionally linked against material value; "No" locks both to 0
        const materialValue = H.num(s.materialValue);
        const marginPctEl = main.querySelector('#marginPctInput'), marginAmtEl = main.querySelector('#marginAmtInput');
        let marginEditing = null;
        marginPctEl.addEventListener('input', () => { if (marginEditing === 'amt') return; marginEditing = 'pct';
          marginAmtEl.value = Math.round(materialValue * (parseFloat(marginPctEl.value) || 0) / 100); marginEditing = null; });
        marginAmtEl.addEventListener('input', () => { if (marginEditing === 'pct') return; marginEditing = 'amt';
          marginPctEl.value = materialValue ? ((parseFloat(marginAmtEl.value) || 0) / materialValue * 100).toFixed(2) : 0; marginEditing = null; });
        main.querySelector('#marginApplies').addEventListener('change', e => {
          const no = e.target.value === 'no';
          marginPctEl.disabled = no; marginAmtEl.disabled = no;
          if (no) { marginPctEl.value = 0; marginAmtEl.value = 0; }
          markDirty();
        });
        main.querySelector('#saveBuyerPocLog').onclick = () => {
          const v = main.querySelector('#buyerPocNote').value.trim();
          if (v) A.postUpdate({ type: 'poc_contact', key: 'buyer', value: v, note: v });
        };
        main.querySelector('#saveSellerPocLog').onclick = () => {
          const v = main.querySelector('#sellerPocNote').value.trim();
          if (v) A.postUpdate({ type: 'poc_contact', key: 'seller', value: v, note: v });
        };
        main.querySelector('#saveAll').onclick = async () => {
          const val = id => main.querySelector(id)?.value;
          const stageVal = val('#stageUpdate'), reasonVal = val('#stageReason'), stageNote = val('#stageNote');
          const issueVal = val('#issueType');
          const ownerVal = (val('#ownerUpdate') || '').trim();
          const invQty = val('#invoiceQtyInput'), recQty = val('#receivedQtyInput');
          const tdsVal = val('#tdsInput');
          const invDate = val('#invoiceDateInput'), terms = val('#paymentTermsInput'), dueDate = val('#dueDateInput');
          const fuDate = val('#fuDate'), fuNote = val('#fuNote');
          const marginAppliesVal = val('#marginApplies'), marginPctVal = val('#marginPctInput'), marginInvoiceStatusVal = val('#marginInvoiceStatus');

          if (stageVal && stageVal !== s.funnel) await A.postUpdate({ type: 'stage', value: stageVal, reason: reasonVal, note: stageNote });
          else if (reasonVal !== (s.blockReason || '') || stageNote) await A.postUpdate({ type: 'stage', value: s.funnel, reason: reasonVal, note: stageNote });
          if (issueVal) await A.postUpdate({ type: 'issue', value: issueVal, note: 'Issue tagged' });
          if (ownerVal && ownerVal !== (s.controlPoc || '')) await A.postUpdate({ type: 'owner', value: ownerVal, note: 'Owner updated' });
          if (invQty) await A.postUpdate({ type: 'qty', key: 'invoiceQty', value: invQty, note: 'Invoice qty updated' });
          if (recQty) await A.postUpdate({ type: 'qty', key: 'receivedQty', value: recQty, note: 'Received qty updated' });
          if (tdsVal) await A.postUpdate({ type: 'payment_detail', key: 'tds', value: tdsVal, note: 'TDS updated' });
          if (invDate) await A.postUpdate({ type: 'invoice_detail', key: 'invoiceDate', value: invDate, note: 'Invoice date updated' });
          if (terms) await A.postUpdate({ type: 'invoice_detail', key: 'paymentTerms', value: terms, note: 'Payment terms updated' });
          if (dueDate) await A.postUpdate({ type: 'invoice_detail', key: 'dueDate', value: dueDate, note: 'Due date updated' });
          if (fuDate && (fuDate !== s.followUp?.dueDate || fuNote !== (s.followUp?.note || ''))) {
            await A.postUpdate({ type: 'followup', value: 'scheduled', dueDate: fuDate, note: fuNote, status: 'open' });
          }
          if (marginAppliesVal && marginAppliesVal !== (s.marginApplies || 'pending')) await A.postUpdate({ type: 'margin', key: 'applies', value: marginAppliesVal, note: 'Margin applicable updated' });
          if (marginAppliesVal !== 'no' && marginPctVal) await A.postUpdate({ type: 'margin', key: 'pctOverride', value: marginPctVal, note: 'Margin % updated' });
          if (marginInvoiceStatusVal && marginInvoiceStatusVal !== (s.marginInvoiceStatus || 'not_raised')) await A.postUpdate({ type: 'margin', key: 'invoiceStatus', value: marginInvoiceStatusVal, note: 'Margin invoice status updated' });
        };
      } else {
        main.querySelectorAll('.section-body button, .section-body input, .section-body select, .section-body textarea, #saveAll').forEach(x => x.disabled = true);
      }
      // collapsible sections — click header (not a control) to fold
      main.querySelectorAll('.section-title').forEach(t => t.onclick = e => {
        if (e.target.closest('button, select, input, textarea, a')) return;
        t.parentElement.classList.toggle('collapsed');
      });
      // cockpit sub-tabs — group the boxes above instead of showing all at once
      main.querySelector('#cockpitTabs').addEventListener('click', e => {
        const b = e.target.closest('.ck-tab'); if (!b) return;
        main.querySelectorAll('.ck-tab').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        main.querySelectorAll('.ck-group').forEach(g => g.hidden = g.dataset.group !== b.dataset.g);
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
      const toISO = d => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '';
      return `<div class="section-box span-2">
        <div class="section-title"><h3>Payment</h3>${badge}</div>
        <div class="section-body">
          <p class="sub" style="margin:-2px 0 2px">Invoice date, terms and due date are entered manually — not from a feed.</p>
          <div class="form-row">
            <input id="invoiceDateInput" type="date" value="${toISO(inv)}" title="Invoice date" />
            <input id="paymentTermsInput" type="text" value="${esc(s.paymentTerms || '')}" placeholder="Terms (e.g. D+15)" />
            <input id="dueDateInput" type="date" value="${toISO(due)}" title="Due date" />
          </div>
          <div class="pay-grid">
            ${pcell('Overdue', overdueTxt)}
            ${pcell('Pending since', since != null ? since + ' days' : '—')}
            ${pcell('Paid', H.shortMoney(paid))}
            ${pcell('Pending', `<span style="color:${bal > 1 ? 'var(--bad)' : 'var(--ok)'}">${H.shortMoney(bal)}</span>`)}
          </div>
          ${H.payMini(s, true)}
          ${s.paidProofPending ? '<p class="docv-note" style="color:var(--bad)">Paid but UTR / payment advice not uploaded in system.</p>' : ''}
          <div class="pay-grid" style="margin-top:8px;border-top:1px dashed var(--line-soft);padding-top:8px">
            ${pcell('GST', H.shortMoney(s.gst))}
            ${pcell('Debit Note', H.shortMoney(s.debitNote))}
          </div>
          <div class="form-row" style="margin-top:6px">
            <input id="tdsInput" type="number" step="0.01" value="${s.tds != null ? s.tds : ''}" placeholder="TDS amount (₹)" />
          </div>
        </div>
      </div>`;
    }

    function qtyBox(s) {
      const shortageFlag = s.shortageStatus === 'clear' ? 'ok' : s.shortageStatus === 'minor_variance' ? 'warn' : s.shortageStatus === 'shortage' ? 'bad' : 'neutral';
      return `<div class="section-box">
        <div class="section-title"><h3>Quantity</h3><span class="badge ${shortageFlag}">${esc(H.title ? H.title(s.shortageStatus || '') : (s.shortageStatus || ''))}</span></div>
        <div class="section-body">
          <div class="form-row"><input id="invoiceQtyInput" type="number" value="${s.invoiceQty || ''}" placeholder="Invoice qty (kg)" /></div>
          <div class="form-row"><input id="receivedQtyInput" type="number" value="${s.receivedQty || ''}" placeholder="Received qty (kg)" /></div>
          ${s.shortageQty != null ? `<p class="sub">Shortage: ${s.shortageQty} kg</p>` : ''}
        </div>
      </div>`;
    }

    function marginBox(s) {
      const locked = s.marginApplies === 'no';
      return `<div class="section-box span-2">
        <div class="section-title"><h3>Supplier Margin</h3><span class="badge neutral">${esc(H.title(s.marginInvoiceStatus || 'not_raised'))}</span></div>
        <div class="section-body">
          <p class="sub" style="margin:-2px 0 2px">Recykal's own commission from the seller — separate from GST/TDS above.</p>
          <div class="form-row">
            <select id="marginApplies">
              <option value="pending" ${s.marginApplies === 'pending' || !s.marginApplies ? 'selected' : ''}>Pending confirmation</option>
              <option value="yes" ${s.marginApplies === 'yes' ? 'selected' : ''}>Yes</option>
              <option value="no" ${s.marginApplies === 'no' ? 'selected' : ''}>No — supplier doesn't agree</option>
            </select>
            <input id="marginPctInput" type="number" step="0.01" value="${(s.marginPct || 0).toFixed(2)}" placeholder="Margin %" ${locked ? 'disabled' : ''} />
            <input id="marginAmtInput" type="number" step="1" value="${Math.round(s.marginAmount || 0)}" placeholder="Margin amount (₹)" ${locked ? 'disabled' : ''} />
            <select id="marginInvoiceStatus">
              <option value="not_raised" ${(s.marginInvoiceStatus || 'not_raised') === 'not_raised' ? 'selected' : ''}>Not raised</option>
              <option value="raised" ${s.marginInvoiceStatus === 'raised' ? 'selected' : ''}>Raised</option>
              <option value="sent" ${s.marginInvoiceStatus === 'sent' ? 'selected' : ''}>Sent to supplier</option>
            </select>
          </div>
        </div>
      </div>`;
    }

    function pocLogBox(s) {
      const fmtLog = e => e ? `<p class="sub">${esc(e.note || '')} — <i>${esc(e.actor || '')}, ${fmtD(new Date(e.createdAt))}${e.shipmentId && e.shipmentId !== s.shipmentId ? ` on ${esc(e.shipmentId)}` : ''}</i></p>` : '<p class="sub">No contact logged yet.</p>';
      return `<div class="section-box span-2">
        <div class="section-title"><h3>POC Contact Log</h3><span class="badge neutral">cross-shipment</span></div>
        <div class="section-body">
          <p class="sub" style="margin:-2px 0 2px">Buyer POC and seller POC are external contacts — never our txn team.</p>
          <div><b class="sub">Buyer POC (${esc(s.brPoc || '—')})</b>${fmtLog(s.lastBuyerPocContact)}</div>
          <div class="form-row"><input id="buyerPocNote" type="text" placeholder="Log a new buyer POC contact…" /><button class="secondary-btn" id="saveBuyerPocLog">Log</button></div>
          <div><b class="sub">Seller POC (${esc(s.srPoc || '—')})</b>${fmtLog(s.lastSellerPocContact)}</div>
          <div class="form-row"><input id="sellerPocNote" type="text" placeholder="Log a new seller POC contact…" /><button class="secondary-btn" id="saveSellerPocLog">Log</button></div>
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
