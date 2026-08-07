/* ──────────────────────────────────────────────────────────────────────────
   OMP Shipment Tracker — shared core (state, data, helpers, page registry)
   Pages register themselves via OMP.registerPage(name, { render(el, OMP) }).
   Pages must ONLY read OMP.state and use OMP.helpers / OMP.actions.
   Each page owns exactly one file in public/pages/. Do not edit core from a page.
   ────────────────────────────────────────────────────────────────────────── */
const OMP = (() => {
  const state = {
    shipments: [], summary: null, stages: [], docs: {}, users: [],
    selectedId: null, selected: null, timeline: [],
    filters: { search: '', stage: '', risk: '', cause: '' },
    pipelineStage: '',
    view: 'overview',
    user: { name: 'Local Admin', email: 'local@recykal.test', role: 'admin' },
  };

  const pages = {};
  const money = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

  /* ── formatting helpers ── */
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  const title = v => String(v || '').replace(/[-_]/g, ' ').replace(/\b\w/g, m => m.toUpperCase());
  const today = () => new Date().toISOString().slice(0, 10);
  const num = v => Math.max(0, Number(v || 0));
  function shortMoney(v) {
    const n = Number(v || 0);
    if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(1)}Cr`;
    if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(1)}L`;
    if (Math.abs(n) >= 1e3) return `₹${(n / 1e3).toFixed(0)}K`;
    return `₹${money.format(n)}`;
  }

  /* ── document model ── */
  const DOC_GROUPS = [
    { label: 'Deal', keys: ['buyerPO'] },
    { label: 'Dispatch', keys: ['vehImages', 'lrCopy', 'weighslip', 'invoice', 'ewaybill'] },
    { label: 'Transit & Delivery', keys: ['tracking', 'pod', 'podDoc'] },
    { label: 'QC / DN', keys: ['qcReport', 'dn'] },
    { label: 'Payment', keys: ['paymentAdvice', 'utr'] },
  ];
  const DOC_STATES = [['missing', 'Missing'], ['pending', 'Pending'], ['ok', 'OK'], ['na', 'NA']];
  const REASONS = [
    ['', 'Select why this is stuck'],
    ['poc_docs_pending', 'POC has not shared docs'],
    ['buyer_approval_pending', 'Buyer approval pending'],
    ['seller_docs_pending', 'Seller docs pending'],
    ['vehicle_lr_pending', 'Vehicle images / LR pending'],
    ['weight_mismatch', 'Weight mismatch'],
    ['ewaybill_invoice_issue', 'E-way bill / invoice issue'],
    ['pod_pending', 'POD pending from buyer'],
    ['qc_dn_pending', 'QC / DN pending'],
    ['payment_pending', 'Payment not released'],
    ['payment_done_proof_pending', 'Payment done, proof / UTR pending'],
    ['payment_done_upload_pending', 'Payment done, buyer/seller not uploaded in system'],
    ['docs_offline_upload_pending', 'Docs available, upload to system pending'],
    ['poc_not_responding', 'POC not responding'],
    ['internal_verification', 'Internal verification pending'],
    ['other', 'Other'],
  ];
  const reasonLabel = code => (REASONS.find(r => r[0] === code) || [null, code])[1];

  /* stage identity — emoji pin + soft pastel tint per stage (Goa-DRS-style flow) */
  const STAGE_META = {
    mm: { ico: '🤝', tint: 'indigo' },
    predispatch: { ico: '📋', tint: 'green' },
    intransit: { ico: '🚚', tint: 'amber' },
    reached: { ico: '📍', tint: 'pink' },
    qc: { ico: '🔎', tint: 'blue' },
    completed: { ico: '✅', tint: 'teal' },
    rejected: { ico: '⛔', tint: 'red' },
  };
  const CAUSE_LABELS = {
    owner_missing: 'Owner not assigned', docs_pending: 'Documents pending',
    payment_overdue: 'Payment overdue', payment_pending: 'Payment pending',
    payment_done_upload_pending: 'Paid · not uploaded in system', qc_dn_pending: 'QC / DN pending',
    followup_due: 'Follow-up due', in_progress: 'In progress (on track)',
  };
  const causeLabel = code => { const rl = reasonLabel(code); return rl !== code ? rl : (CAUSE_LABELS[code] || title(code || '—')); };

  /* ── derived shipment logic ── */
  const isDue = s => !!(s.followUp && s.followUp.dueDate && s.followUp.dueDate <= today() && s.funnel !== 'completed' && s.funnel !== 'rejected');
  function needs(s) {
    if (s.funnel === 'completed' || s.funnel === 'rejected') return false;
    return !!(isDue(s) || !s.controlPoc || s.missingDocs.length || ['overdue', 'pending', 'partial'].includes(s.paymentRisk) || s.funnel === 'qc');
  }
  function score(s) {
    let v = 0;
    if (isDue(s)) v += 70;
    if (!s.controlPoc) v += 50;
    if (s.paymentRisk === 'overdue') v += 45;
    if (s.paymentRisk === 'partial') v += 24;
    if (s.paymentRisk === 'pending') v += 18;
    v += (s.missingDocs?.length || 0) * 12;
    if (s.paidProofPending) v += 20;
    if (s.blockReason) v += 15;
    if (s.funnel === 'qc') v += 22;
    if (s.funnel === 'reached') v += 12;
    return v;
  }
  const ranked = rows => [...rows].sort((a, b) => score(b) - score(a));
  // Personal scope: the shipments this user can act on (own). Admin -> all.
  // Used by the personal views (Overview, My Work); browse/analytics use all.
  const myShipments = () => state.shipments.filter(s => s.canEdit);
  const isScoped = () => state.user && state.user.role !== 'admin';
  function filtered() {
    const f = state.filters;
    return state.shipments.filter(s => {
      const hay = [s.shipmentId, s.orderId, s.buyer, s.seller, s.owner, s.srPoc, s.brPoc, s.material, s.vertical].join(' ').toLowerCase();
      if (f.search && !hay.includes(f.search)) return false;
      if (f.stage && s.funnel !== f.stage) return false;
      if (f.risk === 'needs' && !needs(s)) return false;
      if (f.risk === 'docs' && !s.missingDocs.length) return false;
      if (f.risk === 'overdue' && s.paymentRisk !== 'overdue') return false;
      if (f.risk === 'proof' && !s.paidProofPending) return false;
      if (f.risk === 'unassigned' && s.controlPoc) return false;
      if (f.risk === 'mine' && !s.canEdit) return false;
      if (f.cause && s.cause !== f.cause) return false;
      return true;
    });
  }
  function actionReason(s) {
    if (isDue(s)) return { kind: 'bad', short: 'Today', title: 'Follow-up due', body: `Due ${s.followUp.dueDate}. Act, then log a remark.` };
    if (s.blockReason) return { kind: 'warn', short: 'Blocked', title: reasonLabel(s.blockReason), body: 'Reason logged — push to unblock.' };
    if (!s.controlPoc) return { kind: 'purple', short: 'Owner', title: 'Assign owner', body: 'Control POC is blank.' };
    if (s.paidProofPending) return { kind: 'bad', short: 'Proof', title: 'Payment done, proof not uploaded', body: 'UTR / payment advice missing in system.' };
    if (s.paymentRisk === 'overdue') return { kind: 'bad', short: 'Payment', title: 'Payment follow-up', body: `${shortMoney(s.balance)} balance open.` };
    if (s.missingDocs.length) return { kind: 'warn', short: 'Docs', title: 'Docs pending', body: `Pending: ${s.missingDocs.map(k => state.docs[k] || k).slice(0, 3).join(', ')}` };
    if (s.funnel === 'qc') return { kind: 'info', short: 'QC/DN', title: 'QC / DN closure', body: 'QC or debit note closure required.' };
    if (s.paymentRisk === 'partial') return { kind: 'warn', short: 'Partial', title: 'Partial payment', body: `${shortMoney(s.balance)} balance open.` };
    return { kind: 'info', short: 'Track', title: 'Keep it moving', body: 'Update the next action.' };
  }

  /* ── shared UI atoms ── */
  function payMini(s, big) {
    const paid = num(s.paidAmount), bal = num(s.balance);
    let net = Number(s.netPayable || s.total || 0); if (!(net > 0)) net = paid + bal;
    const pct = net > 0 ? Math.max(0, Math.min(100, Math.round(paid / net * 100))) : (bal > 0 ? 0 : 100);
    const cls = s.paymentRisk === 'overdue' ? 'over' : s.paymentDerived === 'paid' ? 'done' : (s.paymentDerived === 'partial' || s.paymentRisk === 'partial') ? 'part' : 'pend';
    return `<div class="paymini ${cls}${big ? ' big' : ''}"><div class="pm-row"><span class="pm-paid">Paid ${shortMoney(paid)}</span><span class="pm-bal">Bal ${shortMoney(bal)}</span></div><div class="pm-bar"><span style="width:${pct}%"></span></div></div>`;
  }
  function docChip(s) {
    const d = s.docStats;
    if (!d || !d.required) return '<span class="chip neutral">no docs</span>';
    const cls = !d.missing && !d.pending ? 'ok' : d.missing ? 'bad' : 'warn';
    return `<span class="chip ${cls}" title="OK ${d.ok} · Pending ${d.pending} · Missing ${d.missing} · NA ${d.na}">${d.verified}/${d.required} docs</span>`;
  }
  const reasonChip = s => s.blockReason ? `<span class="chip warn" title="Blocker reason">▲ ${esc(reasonLabel(s.blockReason))}</span>` : '';
  const proofChip = s => s.paidProofPending ? '<span class="chip bad" title="Payment cleared but UTR / payment advice not in system">Paid · proof pending</span>' : '';
  function stagePill(s) {
    const cls = s.funnel === 'completed' ? 'ok' : s.funnel === 'rejected' ? 'bad' : s.funnel === 'qc' ? 'info' : 'warn';
    return `<span class="pill ${cls}">${esc(s.stageLabel)}</span>`;
  }
  function paymentPill(s) {
    if (s.paymentDerived === 'paid') return '<span class="pill ok">Paid</span>';
    if (s.paymentRisk === 'overdue') return '<span class="pill bad">Overdue</span>';
    if (s.paymentDerived === 'partial') return '<span class="pill warn">Partial</span>';
    return `<span class="pill neutral">${esc(title(s.paymentDerived || 'pending'))}</span>`;
  }
  function eventHtml(e) {
    let main = e.type === 'doc' ? `${esc(state.docs[e.key] || e.key)} → ${esc(title(e.value))}` : `${esc(title(e.type))} → ${esc(e.value)}`;
    if (e.type === 'followup') main = e.status === 'done' ? 'Follow-up done' : `Follow-up set → ${esc(e.dueDate)}`;
    const reason = e.reason ? `<div class="event-reason">▲ ${esc(reasonLabel(e.reason))}</div>` : '';
    return `<div class="event"><div class="event-top"><span>${esc(e.actor || 'User')}</span><span>${new Date(e.createdAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span></div><div class="event-main">${main}</div>${reason}${e.note ? `<div class="event-note">${esc(e.note)}</div>` : ''}</div>`;
  }
  const stageHelp = key => ({ mm: 'Buyer PO / match lock', predispatch: 'Seller docs before truck', intransit: 'Tracking & ETA', reached: 'Gate-in / POD', qc: 'QC & DN closure', completed: 'Payment & audit clear', rejected: 'Cancelled / rejected' }[key] || 'process step');
  // Pastel emoji stage cards connected by arrows. Pass counts{stageKey:n}; opts {active, big, sub(fn)}.
  function funnelFlow(counts, opts = {}) {
    const active = opts.active || '';
    const cells = state.stages.map((st, i) => {
      const m = STAGE_META[st.key] || { ico: '•', tint: 'indigo' };
      const sub = opts.sub ? opts.sub(st, counts[st.key] || 0) : stageHelp(st.key);
      return `<button class="stage-card t-${m.tint} ${active === st.key ? 'active' : ''}" data-stage="${st.key}">
        <div class="stage-ico">${m.ico}</div>
        <div class="stage-num">${counts[st.key] || 0}</div>
        <div class="stage-rule"></div>
        <div class="stage-name">${esc(st.label)}</div>
        <div class="stage-sub">${esc(sub)}</div>
      </button>`;
    });
    return `<div class="stage-flow ${opts.big ? 'big' : ''}">${cells.join('<div class="stage-arrow">›</div>')}</div>`;
  }
  function stageCounts(rows) { const c = {}; state.stages.forEach(s => c[s.key] = 0); rows.forEach(s => c[s.funnel] = (c[s.funnel] || 0) + 1); return c; }
  const avg = nums => { const c = nums.filter(n => Number.isFinite(n) && n >= 0); return c.length ? Math.round(c.reduce((a, b) => a + b, 0) / c.length) : 0; };

  /* ── data layer ── */
  async function api(path, opt) {
    const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opt });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }
  async function loadBootstrap(email) {
    const d = await api('/api/bootstrap?user=' + encodeURIComponent(email || state.user.email));
    Object.assign(state, { shipments: d.shipments, summary: d.summary, stages: d.stages, docs: d.docs, users: d.users || [], user: d.user || state.user });
    localStorage.setItem('ompUser', state.user.email);
  }
  async function selectShipment(id, rerender = true) {
    const d = await api(`/api/shipments/${encodeURIComponent(id)}?user=${encodeURIComponent(state.user.email)}`);
    state.selectedId = id; state.selected = d.shipment; state.timeline = d.timeline || [];
    if (rerender) renderActive();
  }
  async function postUpdate(payload) {
    await api('/api/updates', { method: 'POST', body: JSON.stringify({ shipmentId: state.selectedId, actor: state.user.name, actorEmail: state.user.email, ...payload }) });
    const boot = await api('/api/bootstrap?user=' + encodeURIComponent(state.user.email));
    state.shipments = boot.shipments; state.summary = boot.summary;
    await selectShipment(state.selectedId, false);
    renderActive();
    toast('Saved');
  }
  function toast(msg) {
    const el = document.createElement('div'); el.className = 'toast'; el.textContent = msg;
    document.getElementById('toastWrap').appendChild(el); setTimeout(() => el.remove(), 1800);
  }

  /* ── view / render orchestration ── */
  function setView(view) {
    state.view = view;
    document.querySelectorAll('.view-tab').forEach(x => x.classList.toggle('active', x.dataset.view === view));
    document.querySelectorAll('.page-view').forEach(x => x.classList.remove('active'));
    const el = document.getElementById('view-' + view); if (el) el.classList.add('active');
    renderActive();
  }
  async function openInCrm(id) { await selectShipment(id, false); setView('crm'); }
  function renderActive() {
    const p = pages[state.view];
    const el = document.getElementById('view-' + state.view);
    if (p && el) { try { p.render(el, OMP); } catch (e) { el.innerHTML = `<pre class="err">${esc(e.message)}\n${esc(e.stack || '')}</pre>`; } }
    // header reflects current scope
    const un = document.getElementById('userName'); if (un) un.textContent = state.user.role === 'admin' ? 'All shipments' : `${state.user.name} · ${myShipments().length} yours`;
  }
  function renderAll() { renderActive(); }

  function registerPage(name, def) { pages[name] = def; }

  async function boot() {
    await loadBootstrap(localStorage.getItem('ompUser') || 'local@recykal.test');
    // header user picker
    const sel = document.getElementById('userSelect');
    if (sel) {
      sel.innerHTML = state.users.map(u => `<option value="${u.email}" ${u.email === state.user.email ? 'selected' : ''}>${esc(u.name)} · ${u.role}</option>`).join('');
      sel.onchange = async e => {
        state.selectedId = null; state.selected = null; state.pipelineStage = '';
        await loadBootstrap(e.target.value);
        const first = ranked(myShipments())[0] || ranked(filtered())[0] || state.shipments[0];
        if (first) await selectShipment(first.shipmentId, false);
        // refresh picker selection labels
        sel.value = state.user.email;
        renderActive();
      };
    }
    // PIN administration only exists in OAuth mode, and only admins can use it.
    // The page is gated server-side as well; this just keeps it out of sight.
    try {
      const me = await (await fetch('/api/me')).json();
      const link = document.getElementById('adminPinsLink');
      if (link && me.authMode === 'google' && me.user && me.user.role === 'admin') link.hidden = false;
    } catch (e) { /* header link is optional — never block boot on it */ }
    document.querySelectorAll('.view-tab').forEach(b => b.onclick = () => setView(b.dataset.view));
    const first = ranked(filtered())[0] || state.shipments[0];
    if (first) await selectShipment(first.shipmentId, false);
    setView(state.view);
  }

  return {
    state, pages, registerPage,
    helpers: { esc, title, today, num, money, shortMoney, DOC_GROUPS, DOC_STATES, REASONS, reasonLabel, STAGE_META, CAUSE_LABELS, causeLabel, isDue, needs, score, ranked, filtered, myShipments, isScoped, actionReason, payMini, docChip, reasonChip, proofChip, stagePill, paymentPill, eventHtml, stageHelp, funnelFlow, stageCounts, avg },
    actions: { api, loadBootstrap, selectShipment, postUpdate, toast, setView, openInCrm, renderActive, renderAll },
    boot,
  };
})();
window.OMP = OMP;
