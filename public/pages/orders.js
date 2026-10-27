/* Page: Orders — the one screen associates work in.
   List (#): a calm full-width table, grouped by what needs attention.
   Order (#order/<shipmentId>): a full page — the route from seller to buyer, then
     Update     = a checklist for the stage the order is at (docs + that stage's columns),
                  a blocker, a required comment, Save / Move to next / Reject;
     Full sheet = every column of the OMP tracker sheet, all editable.
   Columns come from the server's field schema (lib/fields.js), so the sheet and the
   screen never drift. Auto columns (GST, totals, net payable, balance, due date,
   shortages, TDS) show their formula value and can be typed over; "Use auto" resets. */
(() => {
  const FLOW = ['mm', 'predispatch', 'intransit', 'reached', 'qc', 'completed'];
  const ON_TRACK = 'on_track';
  const STAGE_DOCS = {
    mm: ['buyerPO'],
    predispatch: ['vehImages', 'lrCopy', 'weighslip', 'invoice', 'ewaybill'],
    intransit: ['tracking'],
    reached: [],
    qc: ['pod', 'podDoc', 'qcReport', 'dn'],
    completed: ['paymentAdvice', 'utr'],
  };
  const STAGE_BLOCKERS = {
    mm: [['buyer_po_not_shared', 'Buyer PO not shared'], ['po_terms_mismatch', 'PO terms mismatch'], ['commercial_terms_pending', 'Rate, qty or payment terms open']],
    predispatch: [['seller_dispatch_docs_pending', 'Seller dispatch docs pending'], ['vehicle_lr_pending', 'Vehicle or LR pending'], ['invoice_ewaybill_pending', 'Invoice or e-way bill pending'], ['dispatch_not_confirmed', 'Dispatch not confirmed']],
    intransit: [['tracking_not_available', 'Tracking or ETA not available'], ['fastag_sim_issue', 'FASTag or SIM consent issue'], ['vehicle_delayed', 'Vehicle delayed']],
    reached: [['gate_entry_pending', 'Gate entry or unloading pending']],
    qc: [['pod_not_shared', 'POD not shared by buyer'], ['qc_report_pending', 'QC report pending'], ['qty_weight_mismatch', 'Qty or weight mismatch'], ['quality_dispute', 'Quality dispute'], ['dn_pending', 'Debit note pending']],
    completed: [['payment_not_released', 'Payment not released'], ['payment_done_system_upload_pending', 'Paid, proof not uploaded']],
  };
  const COMMON_BLOCKERS = [['poc_not_responding', 'POC not responding'], ['internal_verification_pending', 'Internal verification pending'], ['other', 'Other (explain in the comment)']];
  // Shared with the Pipeline page, so a blocker reads the same everywhere.
  OMP.blockerLabel = code => (Object.values(STAGE_BLOCKERS).flat().concat(COMMON_BLOCKERS).find(b => b[0] === code) || [0, OMP.helpers.reasonLabel(code)])[1];
  const DOC_CHOICES = [['missing', 'Missing'], ['pending', 'Received'], ['ok', 'Verified'], ['na', 'N/A']];
  // One icon per section of the sheet, so each block is recognisable at a glance.
  const SEC_ICON = {
    documents: '<path d="M6 2.5h5.5L15 6v11.5H6z"/><path d="M11.5 2.5V6H15M8.5 10h4M8.5 13h4"/>',
    order: '<path d="M3 6.5 10 3l7 3.5v7L10 17l-7-3.5z"/><path d="M3 6.5 10 10l7-3.5M10 10v7"/>',
    mm: '<path d="M2.5 9.5 6 6l3 2 2-1.5 3.5 3.5"/><path d="M14.5 10l2.5-2.5M6 13l2 2 1.5-1.5L11 15l3.5-3.5"/>',
    invoice: '<path d="M5 2.5h10v15l-2.5-1.5L10 17.5 7.5 16 5 17.5z"/><path d="M8 7h4M8 10h4"/>',
    dispatchChecks: '<rect x="4.5" y="3.5" width="11" height="14" rx="2"/><path d="M7.5 3.5V2h5v1.5M7.5 10.5l2 2 3.5-4"/>',
    tracking: '<path d="M10 17.5s5.5-5 5.5-9A5.5 5.5 0 0 0 4.5 8.5c0 4 5.5 9 5.5 9z"/><circle cx="10" cy="8.5" r="2"/>',
    reached: '<path d="M4.5 17.5V3M4.5 3.5h9l-2 3 2 3h-9"/>',
    delivery: '<path d="M2.5 6.5h10v8h-10zM12.5 9h3l2 2.5v3h-5"/><circle cx="5.5" cy="15.5" r="1.5"/><circle cx="14.5" cy="15.5" r="1.5"/><path d="m5 10 1.8 1.8L10 8.6"/>',
    qc: '<circle cx="9" cy="9" r="5"/><path d="m13 13 4 4M7 9l1.5 1.5L11.5 7.5"/>',
    payment: '<rect x="2.5" y="5" width="15" height="10.5" rx="2"/><path d="M2.5 8.5h15M6 12.5h3"/>',
    issues: '<path d="M10 3 18 17H2z"/><path d="M10 8v4M10 14.5v.1"/>',
  };
  const secIcon = id => `<svg viewBox="0 0 20 20" aria-hidden="true">${SEC_ICON[id] || SEC_ICON.order}</svg>`;
  const ATTN = { stage_days: 'Stage delayed', followup_due: 'Follow-up due', payment_late: 'Payment late' };
  const QUICK = [['', 'All'], ['attention', 'Needs attention'], ['followup_due', 'Follow-up due'], ['payment_late', 'Payment late'], ['stage_days', 'Stage delayed']];

  let scope = null;
  let stageFilter = '';
  let quick = '';
  let search = '';
  let sortKey = '';
  let sortDir = 1;
  let tab = 'update';
  let viewStage = null;
  let newOpen = false;
  let draft = { id: null };
  let listIds = [];
  let hashBound = false;

  const routeId = () => { const m = location.hash.match(/^#order\/(.+)$/); return m ? decodeURIComponent(m[1]) : null; };

  // Two menu tabs share this renderer: Shipments (table + shipment page) and Sheet (every column).
  function renderPage(el, OMP, mode) {
    {
      const { state, helpers: H, actions: A } = OMP;
      const esc = H.esc;
      const isAdmin = state.user.role === 'admin';
      if (!scope) scope = isAdmin ? 'all' : 'mine';
      if (!hashBound) {
        hashBound = true;
        window.addEventListener('hashchange', async () => {
          if (state.view !== 'orders') return;
          const id = routeId();
          if (id && id !== state.selectedId) await A.selectShipment(id, false);
          tab = 'update';
          A.renderActive();
          window.scrollTo(0, 0);
        });
      }
      const SCHEMA = state.fieldSections || [];
      const FIELD = Object.fromEntries(SCHEMA.flatMap(sec => sec.fields.map(f => [f.key, { ...f, section: sec.id }])));

      const listView = mode;
      if (mode === 'table' && location.hash.startsWith('#list?')) {
        const p = new URLSearchParams(location.hash.slice(6));
        stageFilter = p.get('stage') || ''; quick = p.get('quick') || ''; if (p.get('scope')) scope = p.get('scope');
        search = ''; sortKey = '';
        history.replaceState(null, '', location.pathname + location.search);
      }
      const id = mode === 'table' ? routeId() : null;
      if (id) {
        if (state.selectedId !== id || !state.selected) { A.selectShipment(id); return; }
        return renderOrder(state.selected);
      }
      return renderList();

      /* ────────────────────────── list ────────────────────────── */
      function renderList() {
        const me = String(state.user.name || '').trim().toLowerCase();
        const named = v => String(v || '').split('/').some(n => n.trim().toLowerCase() === me);
        const mine = state.shipments.filter(s => named(s.owner));
        const base = scope === 'mine' ? mine : state.shipments;
        const q = search.trim().toLowerCase();
        const closed = r => r.funnel === 'rejected' || !!r.closed;
        const needs = r => (r.attention || []).length > 0;
        const matches = r => (!stageFilter || r.funnel === stageFilter)
          && (!quick || (quick === 'attention' ? needs(r) : (r.attention || []).includes(quick)))
          && (!q || [r.shipmentId, r.orderId, r.buyer, r.seller, r.owner, r.material, r.invoiceNo].join(' ').toLowerCase().includes(q));
        const rows = H.ranked(base.filter(matches));
        const counts = H.stageCounts(base);
        const quickCount = k => base.filter(r => !k ? true : k === 'attention' ? needs(r) : (r.attention || []).includes(k)).length;
        const soCount = {};
        state.shipments.forEach(r => { if (r.orderId) soCount[r.orderId] = (soCount[r.orderId] || 0) + 1; });

        const SORTS = {
          so: r => r.shipmentId, buyer: r => (r.buyer || '').toLowerCase(), stage: r => FLOW.indexOf(r.funnel) < 0 ? 9 : FLOW.indexOf(r.funnel),
          owner: r => (r.owner || '').toLowerCase(), balance: r => H.num(r.balance), updated: r => r.lastUpdateAt || '',
        };
        const COLS = [['so', 'Shipment'], ['buyer', 'Buyer'], ['', 'Material'], ['stage', 'Stage'], ['owner', 'Owner'], ['', 'Attention'], ['balance', 'Payment'], ['updated', 'Updated']];
        let body;
        let ordered;
        if (sortKey) {
          const f = SORTS[sortKey];
          ordered = [...rows].sort((a, b) => (f(a) > f(b) ? 1 : f(a) < f(b) ? -1 : 0) * sortDir);
          body = ordered.map(rowHtml).join('');
        } else {
          const groups = [['Needs attention', rows.filter(r => needs(r) && !closed(r))], ['Moving', rows.filter(r => !needs(r) && !closed(r))], ['Closed', rows.filter(closed)]];
          ordered = groups.flatMap(g => g[1]);
          body = groups.filter(g => g[1].length).map(([label, list]) => `<tr class="o-grp"><th colspan="8">${label}<span>${list.length}</span></th></tr>${list.map(rowHtml).join('')}`).join('');
        }
        listIds = ordered.map(r => r.shipmentId);

        el.innerHTML = `
          <div class="o-page">
            <header class="o-head">
              <div>
                <h1>${mode === 'sheet' ? 'Sheet' : 'Shipments'}</h1>
                <p>${scope === 'mine' ? `${mine.length} assigned to you` : `${state.shipments.length} in total`}</p>
              </div>
              <div class="o-head-actions">
                <label class="o-search"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="6"/><path d="m14 14 4 4"/></svg>
                  <input id="oSearch" type="search" placeholder="Search SO, buyer, seller, invoice" value="${esc(search)}" /></label>
                ${mode === 'table' ? `<button class="o-btn primary" id="oNew">${newOpen ? 'Close' : 'New shipment'}</button>` : ''}
              </div>
            </header>
            ${newOpen && mode === 'table' ? newForm() : ''}
            <div class="o-toolbar">
              <nav class="o-scope" aria-label="Whose orders">
                <button class="${scope === 'mine' ? 'on' : ''}" data-scope="mine">My shipments</button>
                <button class="${scope === 'all' ? 'on' : ''}" data-scope="all">All shipments</button>
              </nav>
            </div>
            <div class="o-filters">
              <div class="o-quick">${QUICK.map(([k, l]) => `<button class="${quick === k ? 'on' : ''} q-${k || 'all'}" data-quick="${k}">${l}<b>${quickCount(k)}</b></button>`).join('')}</div>
              <select id="oStage" aria-label="Stage"><option value="">Every stage</option>${state.stages.map(st => `<option value="${st.key}" ${stageFilter === st.key ? 'selected' : ''}>${esc(sentence(st.label))} (${counts[st.key] || 0})</option>`).join('')}</select>
            </div>
            ${listView === 'sheet' ? sheetView(ordered) : `<div class="o-table-wrap">
              <table class="o-table">
                <thead><tr>${COLS.map(([k, l]) => k ? `<th><button data-sort="${k}" class="${sortKey === k ? 'on' : ''}">${l}${sortKey === k ? (sortDir > 0 ? ' ↑' : ' ↓') : ''}</button></th>` : `<th>${l}</th>`).join('')}</tr></thead>
                <tbody>${body || `<tr><td colspan="8" class="o-empty">No shipments here. ${q || quick || stageFilter ? 'Clear the search or filters to see more.' : ''}</td></tr>`}</tbody>
              </table>
            </div>
            ${sortKey ? '<button class="o-link" id="oUngroup">Group by attention again</button>' : ''}`}
          </div>`;

        el.querySelectorAll('[data-scope]').forEach(b => b.onclick = () => { scope = b.dataset.scope; A.renderActive(); });
        const csv = el.querySelector('#oCsv'); if (csv) csv.onclick = () => downloadCsv(ordered);
        el.querySelectorAll('[data-quick]').forEach(b => b.onclick = () => { quick = b.dataset.quick; A.renderActive(); });
        el.querySelector('#oStage').onchange = e => { stageFilter = e.target.value; A.renderActive(); };
        el.querySelectorAll('[data-sort]').forEach(b => b.onclick = () => { if (sortKey === b.dataset.sort) sortDir = -sortDir; else { sortKey = b.dataset.sort; sortDir = 1; } A.renderActive(); });
        const ug = el.querySelector('#oUngroup'); if (ug) ug.onclick = () => { sortKey = ''; A.renderActive(); };
        const si = el.querySelector('#oSearch');
        si.oninput = () => { search = si.value; A.renderActive(); const n = document.getElementById('oSearch'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); };
        const nb = el.querySelector('#oNew'); if (nb) nb.onclick = () => { newOpen = !newOpen; A.renderActive(); };
        if (newOpen && mode === 'table') wireNew();
        el.querySelectorAll('tr[data-id]').forEach(tr => {
          const go = () => {
            if (mode === 'sheet') { history.replaceState(null, '', '#order/' + encodeURIComponent(tr.dataset.id)); A.setView('orders'); window.scrollTo(0, 0); }
            else location.hash = 'order/' + encodeURIComponent(tr.dataset.id);
          };
          tr.onclick = go;
          tr.onkeydown = e => { if (e.key === 'Enter') go(); };
        });

        // Every shipment x every column, in the tracker's own order. Read here, edit on the order page.
        function sheetCols() {
          const base = [
            { key: 'shipmentId', label: 'Shipment ID', g: 'Shipment', gid: 'order' }, { key: 'orderId', label: 'SO number', g: 'Shipment', gid: 'order' },
            { key: 'stageLabel', label: 'Stage', g: 'Shipment' }, { key: 'owner', label: 'Control POC', g: 'Shipment' }, { key: 'paymentOwner', label: 'Payment owner', g: 'Shipment' },
            { key: 'blockReason', label: 'Blocker', g: 'Shipment', fmt: v => v ? blockerLabel(v) : '' },
          ];
          const fromSchema = SCHEMA.flatMap(sec => sec.fields.filter(f => f.key !== 'orderId').map(f => ({ key: f.key, label: f.label, g: sec.title, gid: sec.id, f })));
          const docs = FLOW.flatMap(k => STAGE_DOCS[k]).map(k => ({ key: 'doc:' + k, label: state.docs[k] || k, g: 'Documents', gid: 'documents', doc: k }));
          return [...base, ...fromSchema, ...docs];
        }
        function cellValue(r, c) {
          if (c.doc) return (DOC_CHOICES.find(d => d[0] === (r.docs || {})[c.doc]) || [0, ''])[1];
          const v = r[c.key];
          if (v === null || v === undefined) return '';
          if (c.fmt) return c.fmt(v);
          const f = c.f;
          if (f && f.opts) return (f.opts.find(o => o[0] === v) || [0, v])[1];
          if (f && f.kind === 'date') return shortDate(v) || String(v);
          if (f && f.kind === 'money' && String(v).trim() !== '') return fmtNum(v);
          return String(v);
        }
        function sheetView(list) {
          const cols = sheetCols();
          const groups = [];
          cols.forEach(c => { const g = groups[groups.length - 1]; if (g && g.name === c.g) g.n++; else groups.push({ name: c.g, id: c.gid, n: 1 }); });
          return `<div class="o-sheetbar"><p>${list.length} shipments, ${cols.length} columns. Scroll sideways to see everything. Click a row to edit it.</p><button class="o-btn small" id="oCsv">Download CSV</button></div>
          <div class="o-xl-wrap"><table class="o-xl">
            <thead><tr>${groups.map(g => `<th colspan="${g.n}" class="g sec-${esc(g.id || 'order')}"><span class="o-g-in">${secIcon(g.id || 'order')}${esc(g.name)}</span></th>`).join('')}</tr>
            <tr>${cols.map((c, i) => `<th class="${i < 2 ? 'stick s' + i : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
            <tbody>${list.map(r => `<tr data-id="${esc(r.shipmentId)}" tabindex="0" class="${(r.attention || []).length ? 'is-attn' : ''}">${cols.map((c, i) => {
              const v = cellValue(r, c);
              const manual = c.f && c.f.auto && r.calc && r.calc[c.key] && r.calc[c.key].overridden ? ' manual' : '';
              const n = c.f && (c.f.kind === 'money' || c.f.kind === 'number') ? ' n' : '';
              return `<td class="${i < 2 ? 'stick s' + i : ''}${n}${manual}" title="${esc(v)}">${esc(v)}</td>`;
            }).join('')}</tr>`).join('')}</tbody>
          </table></div>`;
        }
        function downloadCsv(list) {
          const cols = sheetCols();
          const q = v => /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
          const lines = [cols.map(c => q(c.label)).join(','), ...list.map(r => cols.map(c => q(String(cellValue(r, c)))).join(','))];
          const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `omp-orders-${H.today()}.csv`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        }

        function rowHtml(r) {
          const age = daysAgo(r.lastUpdateAt);
          const owners = String(r.owner || 'Unassigned').split('/').map(n => n.trim().split(' ')[0]).join(', ');
          const flags = (r.attention || []).map(k => {
            if (k === 'followup_due') return `<span class="o-flag late">Follow-up ${esc(shortDate(r.followUp && r.followUp.dueDate))}</span>`;
            if (k === 'payment_late') return `<span class="o-flag late">Payment late</span>`;
            return `<span class="o-flag slow">${r.stageAge}d at stage</span>`;
          });
          if (r.blockReason) flags.push(`<span class="o-flag note">${esc(blockerLabel(r.blockReason))}</span>`);
          const bal = H.num(r.balance), paid = H.num(r.paidAmount);
          const many = r.orderId && soCount[r.orderId] > 1;
          return `<tr data-id="${esc(r.shipmentId)}" tabindex="0" class="${(r.attention || []).length ? 'is-attn' : ''}">
            <td data-l="Shipment"><b class="num">${esc(r.shipmentId)}</b><small class="num">${r.orderId ? esc(r.orderId) : 'No SO'}${many ? `, ${soCount[r.orderId]} trucks` : ''}</small></td>
            <td data-l="Buyer"><b>${esc(r.buyer || '—')}</b><small>from ${esc(r.seller || '—')}</small></td>
            <td data-l="Material"><span class="o-clip">${esc(r.material || '—')}</span><small class="num">${fmtKg(r.qtyKg)}</small></td>
            <td data-l="Stage"><span class="o-stage s-${esc(r.funnel)}">${esc(sentence(r.stageLabel))}</span>${r.closed ? '<small class="o-closed-t">Closed</small>' : ''}</td>
            <td data-l="Owner">${esc(owners)}</td>
            <td data-l="Attention" class="o-flags">${flags.slice(0, 2).join('') || '<span class="o-calm">On track</span>'}</td>
            <td data-l="Payment" class="o-money">${r.funnel === 'rejected' ? '<span class="o-calm">—</span>' : bal > 1 ? `<b class="num">${H.shortMoney(bal)}</b><small class="num">paid ${H.shortMoney(paid)}</small>` : paid > 0 ? '<b class="o-paid">Paid</b>' : '<span class="o-calm">Not invoiced</span>'}</td>
            <td data-l="Updated" class="o-calm">${age === null ? '—' : age === 0 ? 'Today' : age === 1 ? 'Yesterday' : age + ' days ago'}</td>
          </tr>`;
        }
      }

      function newForm() {
        return `<div class="o-new">
          <h2>New shipment</h2>
          <p>Shipments from the backend arrive on their own. Use this only for one entered by hand. Leave owner blank to assign the next person in turn.</p>
          <div class="o-grid">
            <label>SO number<input id="nsOrderId" /></label>
            <label>Buyer<input id="nsBuyer" required /></label>
            <label>Seller<input id="nsSeller" /></label>
            <label>Material<input id="nsMaterial" /></label>
            <label>Qty (kgs)<input id="nsQty" type="number" min="0" /></label>
            <label>Material value (₹)<input id="nsValue" type="number" min="0" /></label>
            <label>Owner<input id="nsOwner" list="nsOwners" placeholder="Next in turn" /></label>
          </div>
          <datalist id="nsOwners">${(state.ownerOptions || []).map(n => `<option value="${esc(n)}">`).join('')}</datalist>
          <p class="o-err" id="nsErr" hidden></p>
          <button class="o-btn primary" id="nsCreate">Create shipment</button>
        </div>`;
      }
      function wireNew() {
        const v = s => el.querySelector(s).value.trim();
        el.querySelector('#nsCreate').onclick = async e => {
          const btn = e.currentTarget; if (btn.disabled) return;
          const err = el.querySelector('#nsErr');
          if (!v('#nsBuyer')) { err.textContent = 'Enter the buyer to create the shipment.'; err.hidden = false; return; }
          btn.disabled = true;
          try {
            const res = await A.api('/api/shipments', { method: 'POST', body: JSON.stringify({ orderId: v('#nsOrderId'), buyer: v('#nsBuyer'), seller: v('#nsSeller'), material: v('#nsMaterial'), qtyKg: v('#nsQty'), materialValue: v('#nsValue'), controlPoc: v('#nsOwner') }) });
            newOpen = false;
            await A.loadBootstrap(state.user.email);
            A.toast(res.autoAssigned ? `Shipment created and assigned to ${res.controlPoc}` : 'Shipment created');
            location.hash = 'order/' + encodeURIComponent(res.shipmentId);
          } catch (e2) {
            err.textContent = apiError(e2, 'The shipment was not created. Try again.'); err.hidden = false; btn.disabled = false;
          }
        };
      }

      /* ────────────────────────── order page ────────────────────────── */
      function renderOrder(s) {
        if (draft.id !== s.shipmentId) {
          const keep = draft.keepFor === s.shipmentId && viewStage;
          draft = { id: s.shipmentId, docs: {}, fields: {}, comment: '', blocker: s.blockReason || ON_TRACK, followup: '' };
          if (!keep) viewStage = s.funnel === 'rejected' ? 'qc' : s.funnel;
        }
        // Opened straight from a link: step through all orders in priority order.
        if (!listIds.includes(s.shipmentId)) listIds = H.ranked(state.shipments).map(x => x.shipmentId);
        const pos = listIds.indexOf(s.shipmentId);
        const prev = pos > 0 ? listIds[pos - 1] : null;
        const next = pos >= 0 && pos < listIds.length - 1 ? listIds[pos + 1] : null;
        const siblings = s.orderId ? state.shipments.filter(x => x.orderId === s.orderId) : [s];

        el.innerHTML = `
          <div class="o-page o-order">
            <div class="o-crumbs">
              <a href="#" id="oBack">All shipments</a>
              <span class="o-crumb-nav">
                <button class="o-icon" id="oPrev" ${prev ? '' : 'disabled'} aria-label="Previous shipment">‹</button>
                <button class="o-icon" id="oNext" ${next ? '' : 'disabled'} aria-label="Next shipment">›</button>
              </span>
            </div>
            <header class="o-order-head">
              <div>
                <p class="o-so num">${esc(s.shipmentId)}<span>${esc(s.orderId || 'No SO number')}</span></p>
                <h1>${esc(s.buyer || 'Buyer not set')}</h1>
                <p class="o-sub">${esc(s.material || 'Material not set')}${s.qtyKg ? `, <span class="num">${fmtKg(s.qtyKg)}</span>` : ''}. Owner ${esc(s.owner || 'unassigned')}.</p>
              </div>
              <div class="o-head-status">
                ${(s.attention || []).map(k => `<span class="o-flag late">${ATTN[k]}</span>`).join('')}
                ${s.blockReason ? `<span class="o-flag note">${esc(blockerLabel(s.blockReason))}</span>` : ''}
                ${s.closed ? '<span class="o-flag ok">Closed: paid and UTR verified</span>' : !(s.attention || []).length && !s.blockReason && s.funnel !== 'rejected' ? '<span class="o-flag ok">On track</span>' : ''}
              </div>
            </header>

            ${route(s)}

            <div class="o-tabs" role="tablist">
              <button role="tab" aria-selected="${tab === 'update'}" class="${tab === 'update' ? 'on' : ''}" data-tab="update">Update</button>
              <button role="tab" aria-selected="${tab === 'sheet'}" class="${tab === 'sheet' ? 'on' : ''}" data-tab="sheet">Full sheet</button>
            </div>

            <div class="o-cols">
              <main class="o-main">
                ${tab === 'update' ? updatePanel(s) : sheetPanel(s)}
                <section class="o-card o-history">
                  <h2>History</h2>
                  ${timeline() || '<p class="o-calm">Nothing logged yet.</p>'}
                </section>
              </main>
              <aside class="o-side">
                ${moneyCard(s)}
                ${peopleCard(s)}
                ${siblings.length > 1 ? soCard(s, siblings) : ''}
                ${isAdmin ? adminCard(s) : ''}
              </aside>
            </div>
          </div>`;
        wireOrder(s, prev, next);
      }

      // The order as a journey: seller → buyer, the stages as stops, the truck where it is now.
      function route(s) {
        const cur = FLOW.indexOf(s.funnel);
        const rejected = s.funnel === 'rejected';
        const truck = '<svg viewBox="0 0 26 16" aria-hidden="true"><path d="M1 2.5h14v9H1zM15 5.5h5l4 4v2h-9z"/><circle cx="5.5" cy="13" r="2.3"/><circle cx="19.5" cy="13" r="2.3"/></svg>';
        return `<section class="o-route ${rejected ? 'is-rejected' : ''}" aria-label="Where this order is">
          <div class="o-route-end"><span>Seller</span><b>${esc(s.seller || '—')}</b></div>
          <ol>${FLOW.map((k, i) => {
            const st = rejected ? 'todo' : i < cur ? 'done' : i === cur ? 'now' : 'todo';
            const viewing = tab === 'update' && k === viewStage;
            return `<li class="${st} ${viewing ? 'viewing' : ''}"><button data-view-stage="${k}" aria-current="${st === 'now' ? 'step' : 'false'}"><i>${st === 'now' ? truck : ''}</i><span>${esc(sentence(stageLabel(k)))}</span></button></li>`;
          }).join('')}</ol>
          <div class="o-route-end to"><span>Buyer</span><b>${esc(s.buyer || '—')}</b></div>
          <p class="o-route-note">${rejected ? `Rejected${s.rejectionReason ? `: ${esc(H.reasonLabel(s.rejectionReason))}` : ''}.` : s.funnel === 'completed' ? (s.closed ? 'Paid and closed.' : H.num(s.balance) > 1 ? `Collecting payment, ${H.shortMoney(H.num(s.balance))} still due.` : 'Paid. Verify the UTR to close it.') : `${s.stageAge != null ? `${s.stageAge} day${s.stageAge === 1 ? '' : 's'}` : 'Now'} at ${esc(sentence(s.stageLabel).toLowerCase())}${s.stageSlaDays ? `, usual limit ${s.stageSlaDays} days` : ''}.`}</p>
        </section>`;
      }

      /* Update tab: checklist for one stage */
      function updatePanel(s) {
        const vs = viewStage;
        const isCurrent = vs === s.funnel;
        const rejected = s.funnel === 'rejected';
        const docs = STAGE_DOCS[vs] || [];
        const sections = SCHEMA.filter(sec => sec.stage === vs);
        const docVal = k => draft.docs[k] || s.docs[k] || 'missing';
        const items = [...docs.map(k => ['ok', 'na'].includes(docVal(k))), ...sections.flatMap(sec => sec.fields.map(f => !!String(val(s, f.key)).trim()))];
        const done = items.filter(Boolean).length;
        const nextKey = isCurrent && !rejected ? FLOW[FLOW.indexOf(s.funnel) + 1] : null;
        const blockers = [...(STAGE_BLOCKERS[vs] || []), ...COMMON_BLOCKERS];
        return `<section class="o-card o-check">
          <header class="o-check-head">
            <div>
              <h2>${esc(sentence(stageLabel(vs)))} checklist</h2>
              <p>${isCurrent ? 'This is where the order is now.' : FLOW.indexOf(vs) < FLOW.indexOf(s.funnel) || rejected ? 'An earlier stage. Fix anything that was missed.' : 'A later stage. You can fill things in early.'}</p>
            </div>
            <div class="o-progress" aria-label="${done} of ${items.length} filled"><b class="num">${done}<span>/${items.length}</span></b><i><em style="width:${items.length ? Math.round(done / items.length * 100) : 0}%"></em></i></div>
          </header>
          ${docs.length ? `<div class="o-block sec-documents">${secHead('documents', 'Documents', `<em>${docs.filter(k => ['ok', 'na'].includes(docVal(k))).length} of ${docs.length} verified</em>`)}${docs.map(k => `
            <div class="o-row ${['ok', 'na'].includes(docVal(k)) ? 'is-done' : ''}">
              <span class="o-tick" aria-hidden="true"></span>
              <span class="o-row-label">${esc(state.docs[k] || k)}</span>
              <div class="o-seg" role="group" aria-label="${esc(state.docs[k] || k)}">${DOC_CHOICES.map(([v, l]) => `<button type="button" class="${docVal(k) === v ? 'on d-' + v : ''}" data-doc="${k}" data-val="${v}">${l}</button>`).join('')}</div>
            </div>`).join('')}</div>` : ''}
          ${sections.map(sec => `<div class="o-block sec-${sec.id}">${secHead(sec.id, sec.title, `<em>${sec.fields.filter(f => String(val(s, f.key)).trim() || ((s.calc || {})[f.key] && (s.calc || {})[f.key].auto)).length} of ${sec.fields.length} filled</em>`)}<div class="o-rows">${sec.fields.map(f => fieldRow(s, f)).join('')}</div></div>`).join('')}
          ${!rejected || !isCurrent ? `
          <div class="o-block o-say">
            ${isCurrent ? `<label class="o-label">Anything blocking?
              <select id="oBlocker"><option value="${ON_TRACK}">Nothing, it's on track</option>${blockers.map(([v, l]) => `<option value="${v}" ${draft.blocker === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>` : ''}
            <label class="o-label"><span>Comment ${isCurrent ? '<em>required</em>' : '<em class="opt">optional</em>'}</span>
              <textarea id="oComment" rows="3" placeholder="What happened, who you spoke to, what happens next">${esc(draft.comment)}</textarea></label>
            ${isCurrent ? `<div class="o-follow"><label class="o-label">Next follow-up<input id="oFollow" type="date" value="${esc(draft.followup)}" /></label>
              ${s.followUp ? `<p class="o-calm">Open follow-up on ${esc(shortDate(s.followUp.dueDate))}${s.followUp.note ? `: ${esc(s.followUp.note)}` : ''}. <button class="o-link" id="oFuDone">Mark it done</button></p>` : ''}</div>` : ''}
            <p class="o-err" id="oErr" hidden></p>
          </div>
          <footer class="o-actions">
            <button class="o-btn" id="oSave">${isCurrent ? 'Save update' : 'Save'}</button>
            <span class="o-grow"></span>
            ${isCurrent && s.funnel !== 'completed' ? '<button class="o-btn danger" id="oReject">Reject order</button>' : ''}
            ${nextKey ? `<button class="o-btn primary" id="oNextStage">Move to ${esc(sentence(stageLabel(nextKey)).toLowerCase())}</button>` : ''}
          </footer>
          <div class="o-reject" id="oRejectBox" hidden>
            <label class="o-label">Why is it rejected?<select id="oRejectReason">${H.REJECTION_REASONS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></label>
            <button class="o-btn danger" id="oRejectConfirm">Reject order</button>
          </div>` : ''}
        </section>`;
      }

      /* Full sheet tab: every column, grouped like the sheet */
      function sheetPanel(s) {
        return `<section class="o-card o-sheet">
          <header class="o-check-head"><div><h2>Full sheet</h2><p>Every column from the OMP tracker. Change anything, then save.</p></div></header>
          ${SCHEMA.map(sec => `<div class="o-block sec-${sec.id}">${secHead(sec.id, sec.title, sec.stage ? `<em>${esc(sentence(stageLabel(sec.stage)))}</em>` : '')}<div class="o-sheet-grid">${sec.fields.map(f => fieldRow(s, f, true)).join('')}</div></div>`).join('')}
          <div class="o-block sec-documents">${secHead('documents', 'Documents')}<div class="o-sheet-grid">${FLOW.flatMap(k => STAGE_DOCS[k]).map(k => {
            const v = draft.docs[k] || s.docs[k] || 'missing';
            return `<label class="o-cell"><span>${esc(state.docs[k] || k)}</span><select data-doc-select="${k}">${DOC_CHOICES.map(([o, l]) => `<option value="${o}" ${o === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
          }).join('')}</div></div>
          <div class="o-block o-say"><label class="o-label"><span>Note <em class="opt">optional</em></span><textarea id="oComment" rows="2" placeholder="Why these changes">${esc(draft.comment)}</textarea></label><p class="o-err" id="oErr" hidden></p></div>
          <footer class="o-actions"><span class="o-grow"></span><button class="o-btn primary" id="oSheetSave">Save changes</button></footer>
        </section>`;
      }

      function secHead(id, title, extra) {
        return `<h3 class="o-sec-h"><i class="o-sec-ic">${secIcon(id)}</i><span>${esc(title)}</span>${extra || ''}</h3>`;
      }
      function val(s, key) {
        if (key in draft.fields) return draft.fields[key];
        const f = FIELD[key];
        let v = s[key];
        if (v === null || v === undefined) v = '';
        v = String(v);
        if (f && f.kind === 'date') v = toISO(v);
        return v;
      }
      function fieldRow(s, f, compact) {
        const v = val(s, f.key);
        const c = (s.calc || {})[f.key];
        const typed = f.key in draft.fields;
        const isManual = c && (typed ? draft.fields[f.key] !== '' : c.overridden);
        const autoText = c && c.auto !== null && c.auto !== undefined && c.auto !== '' ? (f.kind === 'money' ? '₹' + fmtNum(c.auto) : f.kind === 'date' ? shortDate(c.auto) : fmtNum(c.auto)) : '';
        let input;
        const common = `data-field="${f.key}" id="f-${f.key}"`;
        if (f.kind === 'long') input = `<textarea ${common} rows="2">${esc(v)}</textarea>`;
        else if (f.opts) input = `<select ${common}><option value="">—</option>${f.opts.map(([o, l]) => `<option value="${esc(o)}" ${o === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
        else if (f.suggest) input = `<div class="o-picks"><input ${common} type="text" list="dl-${f.key}" value="${esc(v)}" placeholder="${esc(f.hint || '')}" autocomplete="off" /><datalist id="dl-${f.key}">${f.suggest.map(o => `<option value="${esc(o)}">`).join('')}</datalist>
          <span class="o-chips" role="group" aria-label="${esc(f.label)} quick picks">${f.suggest.slice(0, 6).map(o => `<button type="button" class="${o === v ? 'on' : ''}" data-pick="${f.key}" data-val="${esc(o)}">${esc(o)}</button>`).join('')}</span></div>`;
        else input = `<input ${common} type="${f.kind === 'date' ? 'date' : f.kind === 'number' || f.kind === 'money' ? 'number' : 'text'}" ${f.kind === 'number' || f.kind === 'money' ? 'step="any"' : ''} value="${esc(v)}" placeholder="${esc(c && !isManual ? (autoText || 'auto') : f.hint || '')}" />`;
        const autoNote = c ? `<span class="o-auto ${isManual ? 'manual' : ''}">${isManual ? `Manual${c.from === 'sheet' && !typed ? ' (from sheet)' : ''}${autoText ? `, formula gives ${esc(autoText)}` : ''} <button type="button" class="o-link" data-reset="${f.key}">Use auto</button>` : 'Auto'}</span>` : '';
        const filled = !!String(v).trim() || (c && autoText);
        if (compact) return `<label class="o-cell ${f.kind === 'long' ? 'wide' : ''}" for="f-${f.key}"><span>${esc(f.label)}</span>${input}${autoNote}</label>`;
        return `<div class="o-row ${filled ? 'is-done' : ''} ${f.kind === 'long' ? 'is-long' : ''}">
          <span class="o-tick" aria-hidden="true"></span>
          <label class="o-row-label" for="f-${f.key}">${esc(f.label)}${f.hint && !c ? `<small>${esc(f.hint)}</small>` : ''}</label>
          <div class="o-row-input ${f.kind === 'long' ? 'wide' : ''}">${input}${autoNote}</div>
        </div>`;
      }

      function moneyCard(s) {
        if (s.funnel === 'rejected') return '';
        const bal = H.num(s.balance), paid = H.num(s.paidAmount), net = H.num(s.netPayable);
        const pct = net > 0 ? Math.min(100, Math.round(paid / net * 100)) : 0;
        const due = parseD(s.dueDate);
        const days = due ? Math.floor((Date.now() - due) / 86400000) : null;
        const dueText = bal <= 1 ? (paid > 0 ? 'Fully paid' : 'Nothing billed yet') : !due ? 'No due date yet' : days > 0 ? `${days} day${days === 1 ? '' : 's'} late` : days === 0 ? 'Due today' : `Due in ${-days} day${days === -1 ? '' : 's'}`;
        return `<section class="o-card o-money-card ${s.paymentRisk === 'overdue' ? 'is-late' : ''}">
          <h2>Payment</h2>
          <p class="o-bal"><span>Balance</span><b class="num">${H.shortMoney(bal)}</b></p>
          <div class="o-bar" aria-hidden="true"><i style="width:${pct}%"></i></div>
          <p class="o-due">${dueText}${due && bal > 1 ? `, ${esc(shortDate(s.dueDate))}` : ''}</p>
          <dl>
            <div><dt>Net payable</dt><dd class="num">${H.shortMoney(net)}</dd></div>
            <div><dt>Paid</dt><dd class="num">${H.shortMoney(paid)}</dd></div>
            <div><dt>TDS</dt><dd class="num">${H.shortMoney(H.num(s.itTds) + H.num(s.gstTds) || H.num(s.impliedTds))}</dd></div>
            <div><dt>Debit note</dt><dd class="num">${H.shortMoney(H.num(s.totalDn))}</dd></div>
          </dl>
          ${s.paidProofPending ? '<p class="o-warn">Paid, but the UTR and payment advice are not uploaded.</p>' : ''}
        </section>`;
      }
      function peopleCard(s) {
        const contact = (side, name, last) => `<div class="o-contact">
          <p><b>${esc(name || 'Not set')}</b><span>${side === 'buyer' ? 'Buyer' : 'Seller'} POC</span></p>
          <p class="o-calm">${last ? `Last contact ${esc(shortDate(last.createdAt))}: ${esc(last.note || '')}` : 'No contact logged yet.'}</p>
          <div class="o-inline"><input id="oPoc-${side}" placeholder="Log a call or message" /><button class="o-btn small" data-poc="${side}">Log</button></div>
        </div>`;
        return `<section class="o-card o-people">
          <h2>People</h2>
          <label class="o-label">Owner<input id="oOwner" list="oOwners" value="${esc(s.controlPoc || '')}" /></label>
          <label class="o-label">Payment owner<input id="oPayOwner" list="oOwners" value="${esc(s.paymentOwner || '')}" /></label>
          <datalist id="oOwners">${(state.ownerOptions || []).map(n => `<option value="${esc(n)}">`).join('')}</datalist>
          <button class="o-btn small" id="oPeopleSave">Save people</button>
          ${contact('buyer', s.brPoc, s.lastBuyerPocContact)}
          ${contact('seller', s.srPoc, s.lastSellerPocContact)}
          <label class="o-label">Issue tag<select id="oIssue"><option value="">None</option>${H.ISSUE_TYPES.filter(([v]) => v).map(([v, l]) => `<option value="${v}" ${v === (s.issueType || '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        </section>`;
      }
      function soCard(s, siblings) {
        const kg = siblings.reduce((a, x) => a + H.num(x.qtyKg), 0);
        return `<section class="o-card o-so-card">
          <h2>This sale order</h2>
          <p class="o-calm">${siblings.length} trucks, <span class="num">${fmtKg(kg)}</span> in total.</p>
          <ul>${siblings.map(x => `<li class="${x.shipmentId === s.shipmentId ? 'here' : ''}"><a href="#order/${encodeURIComponent(x.shipmentId)}"><span class="num">${esc(x.shipmentId)}</span><span class="o-stage s-${esc(x.funnel)}">${esc(sentence(x.stageLabel))}</span></a></li>`).join('')}</ul>
        </section>`;
      }
      function adminCard(s) {
        return `<section class="o-card">
          <h2>Admin</h2>
          <label class="o-label">Set stage directly<select id="oStageSet">${state.stages.map(st => `<option value="${st.key}" ${st.key === s.funnel ? 'selected' : ''}>${esc(sentence(st.label))}</option>`).join('')}</select></label>
          <button class="o-btn small" id="oStageSave">Set stage</button>
          <p class="o-calm">Needs a comment in the checklist.</p>
        </section>`;
      }

      // One entry per save: what was done, the comment, any blocker, then what changed.
      function timeline() {
        const chrono = [...state.timeline].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
        const groups = [];
        for (const e of chrono) {
          const g = groups[groups.length - 1];
          const t = Date.parse(e.createdAt);
          // One save = one entry: a batch writes its events a millisecond apart, so group only
          // events that follow each other within 300 ms, and never two stage events together.
          const joinable = g && g.actor === e.actor && t - g.last < 300 && e.type !== 'poc_contact' && g.first.type !== 'poc_contact'
            && !(e.type === 'stage' && g.items.some(x => x.type === 'stage'));
          if (joinable) { g.items.push(e); g.last = t; }
          else groups.push({ actor: e.actor, t, last: t, first: e, items: [e] });
        }
        let stage = 'mm';
        return groups.map(g => {
          const st = g.items.find(e => e.type === 'stage');
          let head = '';
          let kind = 'plain';
          if (st) {
            head = st.value !== stage ? `Moved to ${esc(sentence(stageLabel(st.value)).toLowerCase())}` : `Update at ${esc(sentence(stageLabel(st.value)).toLowerCase())}`;
            kind = st.value !== stage ? 'move' : 'update';
            if (st.value === 'rejected') kind = 'reject';
            stage = st.value;
          }
          const changes = [];
          for (const e of g.items) {
            if (e === st) continue;
            if (e.type === 'note') { if (!head) head = esc(e.value); else changes.push(esc(e.value)); }
            else if (e.type === 'doc') changes.push(`${esc(state.docs[e.key] || e.key)}: ${esc((DOC_CHOICES.find(d => d[0] === e.value) || [0, e.value])[1])}`);
            else if (e.type === 'owner') changes.push(`${e.key === 'payment' ? 'Payment owner' : 'Owner'}: ${esc(e.value)}`);
            else if (e.type === 'followup') changes.push(e.status === 'done' ? 'Follow-up done' : `Follow-up set for ${esc(shortDate(e.dueDate))}`);
            else if (e.type === 'poc_contact') { head = `Called the ${e.key === 'seller' ? 'seller' : 'buyer'} POC`; changes.push(esc(e.note || e.value)); }
            else if (e.type === 'issue') changes.push(`Issue tag: ${esc(H.issueTypeLabel(e.value))}`);
            else changes.push(changeText(e));
          }
          if (!head) head = changes.length === 1 ? changes.shift() : 'Updated the sheet';
          const when = new Date(g.t).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
          const reason = st && st.reason;
          return `<article class="o-ev ev-${kind}">
            <p class="o-ev-top"><b>${esc(g.actor || 'Someone')}</b><time>${when}</time></p>
            <p class="o-ev-head">${head}</p>
            ${reason === ON_TRACK ? '<p class="o-ev-tag ok">Blocker cleared</p>' : reason ? `<p class="o-ev-tag">Blocked: ${esc(blockerLabel(reason))}</p>` : ''}
            ${st && st.note ? `<p class="o-ev-note">${esc(st.note)}</p>` : ''}
            ${changes.length ? `<ul>${changes.map(c => `<li>${c}</li>`).join('')}</ul>` : ''}
          </article>`;
        }).reverse().join('');
      }
      function changeText(e) {
        const legacy = { tds: 'itTds', pctOverride: 'marginPctOverride', applies: 'marginApplies', invoiceStatus: 'marginInvoiceStatus' };
        const f = FIELD[e.key] || FIELD[legacy[e.key]];
        const label = f ? f.label : H.title(e.key);
        if (e.value === '' || e.value === null) return `${esc(label)}: cleared`;
        let shown = e.value;
        if (f && f.opts) shown = (f.opts.find(o => o[0] === e.value) || [0, e.value])[1];
        else if (f && f.kind === 'date') shown = shortDate(e.value);
        else if (f && f.kind === 'money') shown = '₹' + fmtNum(e.value);
        return `${esc(label)}: ${esc(shown)}`;
      }

      function wireOrder(s, prev, next) {
        const q = sel => el.querySelector(sel);
        q('#oBack').onclick = e => { e.preventDefault(); location.hash = ''; };
        if (prev) q('#oPrev').onclick = () => { location.hash = 'order/' + encodeURIComponent(prev); };
        if (next) q('#oNext').onclick = () => { location.hash = 'order/' + encodeURIComponent(next); };
        el.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; A.renderActive(); });
        el.querySelectorAll('[data-view-stage]').forEach(b => b.onclick = () => { tab = 'update'; viewStage = b.dataset.viewStage; A.renderActive(); });
        const cm = q('#oComment'); if (cm) cm.oninput = () => { draft.comment = cm.value; };
        const bl = q('#oBlocker'); if (bl) bl.onchange = () => { draft.blocker = bl.value; };
        const fu = q('#oFollow'); if (fu) fu.onchange = () => { draft.followup = fu.value; };
        el.querySelectorAll('[data-doc]').forEach(b => b.onclick = () => { draft.docs[b.dataset.doc] = b.dataset.val; A.renderActive(); });
        el.querySelectorAll('[data-doc-select]').forEach(x => x.onchange = () => { draft.docs[x.dataset.docSelect] = x.value; });
        el.querySelectorAll('[data-field]').forEach(inp => {
          const set = () => { draft.fields[inp.dataset.field] = inp.value; };
          inp.addEventListener('input', set); inp.addEventListener('change', set);
        });
        el.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => { draft.fields[b.dataset.pick] = b.dataset.val; A.renderActive(); });
        el.querySelectorAll('[data-reset]').forEach(b => b.onclick = e => {
          e.preventDefault();
          const k = b.dataset.reset; const c = (s.calc || {})[k];
          // A sheet-imported value is re-applied unless the formula value is written explicitly.
          draft.fields[k] = c && c.from === 'sheet' && c.auto !== null ? String(c.auto) : '';
          if (draft.fields[k] === '' && !(c && c.overridden)) delete draft.fields[k];
          A.renderActive();
        });

        const err = msg => { const e = q('#oErr'); if (e) { e.textContent = msg; e.hidden = false; e.scrollIntoView({ block: 'center', behavior: 'smooth' }); } else A.toast(msg); };
        const needComment = () => { if (!draft.comment.trim()) { err('Add a comment: what happened at this step.'); if (cm) cm.focus(); return false; } return true; };
        const send = payload => A.api('/api/updates', { method: 'POST', body: JSON.stringify({ shipmentId: s.shipmentId, actorEmail: state.user.email, ...payload }) });
        const batch = events => events.length ? send({ events }) : Promise.resolve();
        const comment = () => draft.comment.trim();
        function changes() {
          const out = [];
          for (const [key, value] of Object.entries(draft.docs)) if (value !== s.docs[key]) out.push({ type: 'doc', key, value, note: '' });
          for (const [key, value] of Object.entries(draft.fields)) {
            // Auto columns compare against the current manual override ('' = none); others against the stored value.
            const c = (s.calc || {})[key];
            const current = c ? (c.overridden ? String(s[key] ?? '') : '')
              : FIELD[key] && FIELD[key].kind === 'date' ? toISO(s[key]) : String(s[key] ?? '');
            if (String(value) === current) continue;
            out.push({ type: 'field', key, value, note: '' });
          }
          return out;
        }
        async function run(fn, msg, keepStage) {
          el.querySelectorAll('.o-order button').forEach(b => { b.disabled = true; });
          try {
            await fn();
            draft = { id: null, keepFor: keepStage ? s.shipmentId : null };
            await A.loadBootstrap(state.user.email);
            await A.selectShipment(s.shipmentId, false);
            A.renderActive();
            A.toast(msg);
          } catch (e) {
            el.querySelectorAll('.o-order button').forEach(b => { b.disabled = false; });
            err(apiError(e, 'Not saved. Check your connection and try again.'));
          }
        }
        const save = q('#oSave');
        if (save) save.onclick = () => {
          const isCurrent = viewStage === s.funnel;
          if (isCurrent && !needComment()) return;
          const ev = changes();
          if (isCurrent) ev.push({ type: 'stage', value: s.funnel, reason: draft.blocker, note: comment() });
          else if (comment()) ev.push({ type: 'note', value: comment(), note: '' });
          if (isCurrent && draft.followup) ev.push({ type: 'followup', value: 'scheduled', status: 'open', dueDate: draft.followup, note: comment() });
          if (!ev.length) return err('Nothing has changed yet.');
          run(() => batch(ev), isCurrent ? 'Update saved' : 'Saved', !isCurrent);
        };
        const nx = q('#oNextStage');
        if (nx) nx.onclick = () => {
          if (!needComment()) return;
          const to = FLOW[FLOW.indexOf(s.funnel) + 1];
          const ev = [...changes(), { type: 'stage', value: to, reason: '', note: comment() }];
          if (draft.followup) ev.push({ type: 'followup', value: 'scheduled', status: 'open', dueDate: draft.followup, note: comment() });
          run(async () => { await batch(ev); viewStage = to; }, `Moved to ${sentence(stageLabel(to)).toLowerCase()}`, true);
        };
        const rj = q('#oReject'); if (rj) rj.onclick = () => { q('#oRejectBox').hidden = false; q('#oRejectReason').focus(); };
        const rc = q('#oRejectConfirm');
        if (rc) rc.onclick = () => {
          const reason = q('#oRejectReason').value;
          if (!reason) return err('Choose why the order is rejected.');
          if (needComment()) run(() => batch([...changes(), { type: 'stage', value: 'rejected', reason, note: comment() }]), 'Order rejected');
        };
        const sh = q('#oSheetSave');
        if (sh) sh.onclick = () => {
          const ev = changes();
          if (comment()) ev.push({ type: 'note', value: comment(), note: '' });
          if (!ev.length) return err('Nothing has changed yet.');
          run(() => batch(ev), 'Changes saved', true);
        };
        const fd = q('#oFuDone');
        if (fd) fd.onclick = () => run(() => send({ type: 'followup', value: 'done', status: 'done', dueDate: H.today(), note: comment() || 'Follow-up done' }), 'Follow-up marked done', true);
        const ps = q('#oPeopleSave');
        if (ps) ps.onclick = () => {
          const o = q('#oOwner').value.trim(), p = q('#oPayOwner').value.trim();
          const ev = [];
          if (o && o !== (s.controlPoc || '')) ev.push({ type: 'owner', value: o, note: '' });
          if (p && p !== (s.paymentOwner || '')) ev.push({ type: 'owner', key: 'payment', value: p, note: '' });
          if (!ev.length) return A.toast('Nothing has changed yet.');
          run(() => batch(ev), 'People saved', true);
        };
        el.querySelectorAll('[data-poc]').forEach(b => b.onclick = () => {
          const side = b.dataset.poc, v = q('#oPoc-' + side).value.trim();
          if (!v) return q('#oPoc-' + side).focus();
          run(() => send({ type: 'poc_contact', key: side, value: v, note: v }), 'Contact logged', true);
        });
        const is = q('#oIssue');
        if (is) is.onchange = () => { if (is.value) run(() => send({ type: 'issue', value: is.value, note: '' }), 'Issue tagged', true); };
        const ss = q('#oStageSave');
        if (ss) ss.onclick = () => {
          if (!needComment()) return;
          const to = q('#oStageSet').value;
          run(async () => { await send({ type: 'stage', value: to, reason: '', note: comment() }); viewStage = to === 'rejected' ? 'qc' : to; }, `Stage set to ${sentence(stageLabel(to)).toLowerCase()}`, true);
        };
      }

      /* ────────────────────────── helpers ────────────────────────── */
      function stageLabel(k) { return (state.stages.find(x => x.key === k) || {}).label || k; }
      function sentence(t) { const v = String(t || ''); return v.charAt(0).toUpperCase() + v.slice(1).toLowerCase(); }
      function blockerLabel(code) {
        const all = [...Object.values(STAGE_BLOCKERS).flat(), ...COMMON_BLOCKERS];
        return (all.find(b => b[0] === code) || [0, H.reasonLabel(code)])[1];
      }
      function apiError(e, fallback) { try { return JSON.parse(e.message).error || fallback; } catch (_) { return fallback; } }
      function daysAgo(iso) { if (!iso) return null; const d = new Date(iso); return isNaN(d) ? null : Math.max(0, Math.floor((Date.now() - d) / 86400000)); }
      function fmtNum(v) { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : String(v); }
      function fmtKg(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n.toLocaleString('en-IN') + ' kg' : ''; }
      function parseD(v) {
        if (!v) return null; const t = String(v).trim(); if (!t || t.toLowerCase() === 'na') return null;
        if (/^\d{4}-\d{2}-\d{2}/.test(t)) return new Date(t.slice(0, 10) + 'T00:00:00');
        const m = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/); if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
        const d = new Date(t); return isNaN(d) ? null : d;
      }
      function toISO(v) { const d = parseD(v); return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : ''; }
      function shortDate(v) { const d = parseD(v); return d ? d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : ''; }
    }
  }
  OMP.registerPage('orders', { render: (el, O) => renderPage(el, O, 'table') });
  OMP.registerPage('sheet', { render: (el, O) => renderPage(el, O, 'sheet') });
})();

