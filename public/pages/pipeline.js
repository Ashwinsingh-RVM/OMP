/* Page: Pipeline — a funnel of the six stages, then the shipments of the chosen stage.
   Each funnel bar is as long as the number of shipments at that stage; the amber end is the
   share over the stage's day limit. Click a bar to list that stage below; a row opens the
   shipment page, where the stage is moved on with its checklist and comment. */
(() => {
  const FLOW = ['mm', 'predispatch', 'intransit', 'reached', 'qc', 'completed'];
  let scope = null;
  let search = '';
  let owner = '';
  let vertical = '';
  let onlyAttention = false;
  let showClosed = false;
  let picked = null;          // stage whose shipments are listed

  // Stage + detail icons (stroke, 20x20). Shared with the Dashboard via OMP.stageIcon.
  const ICON = {
    mm: '<path d="M6 2.5h5.5L15 6v11.5H6z"/><path d="M11.5 2.5V6H15M8.5 12.5l4-4 1.5 1.5-4 4H8.5z"/>',
    predispatch: '<path d="M3 6.5 10 3l7 3.5v7L10 17l-7-3.5z"/><path d="M3 6.5 10 10l7-3.5M10 10v7"/>',
    intransit: '<path d="M1.5 5.5h10v8h-10zM11.5 8h3.5l3 3v2.5h-6.5"/><circle cx="5" cy="14.5" r="1.7"/><circle cx="14.5" cy="14.5" r="1.7"/>',
    reached: '<path d="M10 17.5s5.5-5 5.5-9A5.5 5.5 0 0 0 4.5 8.5c0 4 5.5 9 5.5 9z"/><circle cx="10" cy="8.5" r="2"/>',
    qc: '<path d="M3 6.5 10 3l7 3.5v7L10 17l-7-3.5z"/><path d="m7 10 2 2 4-4"/>',
    completed: '<rect x="2.5" y="5" width="15" height="10.5" rx="2"/><path d="M2.5 8.5h15M13 12.5h2"/>',
    rejected: '<circle cx="10" cy="10" r="7.5"/><path d="m7.5 7.5 5 5M12.5 7.5l-5 5"/>',
    clock: '<circle cx="10" cy="10" r="7"/><path d="M10 6v4l2.5 2"/>',
    calendar: '<rect x="3" y="4.5" width="14" height="12.5" rx="2"/><path d="M3 8.5h14M7 2.5v4M13 2.5v4"/>',
    chat: '<path d="M3.5 4.5h13v9h-8l-3.5 3v-3H3.5z"/>',
    user: '<circle cx="10" cy="7" r="3.2"/><path d="M3.5 17c.8-3.4 3.4-5 6.5-5s5.7 1.6 6.5 5"/>',
    arrow: '<path d="M7.5 4.5 13 10l-5.5 5.5"/>',
  };
  const ic = k => `<svg class="p-ic" viewBox="0 0 20 20" aria-hidden="true">${ICON[k] || ''}</svg>`;
  OMP.stageIcon = ic;

  OMP.registerPage('pipeline', {
    render(el, OMP) {
      const { state, helpers: H, actions: A } = OMP;
      const esc = H.esc;
      if (!scope) scope = state.user.role === 'admin' ? 'all' : 'mine';
      const me = String(state.user.name || '').trim().toLowerCase();
      const named = v => String(v || '').split('/').some(n => n.trim().toLowerCase() === me);
      const q = search.trim().toLowerCase();
      const stageLabel = k => (state.stages.find(x => x.key === k) || {}).label || k;
      const sentence = t => { const v = String(t || ''); return v.charAt(0).toUpperCase() + v.slice(1).toLowerCase(); };
      const firstNames = v => String(v || 'Unassigned').split('/').map(n => n.trim().split(' ')[0]).join(', ');
      const ownersOf = s => String(s.owner || 'Unassigned').split('/').map(x => x.trim() || 'Unassigned');

      const mineOrAll = scope === 'mine' ? state.shipments.filter(s => named(s.owner)) : state.shipments;
      const base = mineOrAll.filter(s => s.funnel !== 'rejected' && (showClosed || !s.closed));
      const rows = base.filter(s => (!owner || ownersOf(s).includes(owner)) && (!vertical || (s.vertical || 'No vertical') === vertical)
        && (!onlyAttention || (s.attention || []).length)
        && (!q || [s.shipmentId, s.orderId, s.buyer, s.seller, s.owner, s.material].join(' ').toLowerCase().includes(q)));
      const byStage = Object.fromEntries(FLOW.map(k => [k, rows.filter(s => s.funnel === k)]));
      const max = Math.max(1, ...FLOW.map(k => byStage[k].length));
      if (!picked) picked = FLOW.find(k => byStage[k].some(s => (s.attention || []).length)) || 'mm';
      const allOwners = [...new Set(state.shipments.flatMap(ownersOf))].sort();
      const allVerticals = [...new Set(state.shipments.map(s => s.vertical || 'No vertical'))].sort();
      const rejectedCount = mineOrAll.filter(s => s.funnel === 'rejected').length;
      const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

      const bar = k => {
        const list = byStage[k];
        const late = list.filter(s => (s.attention || []).includes('stage_days') || (k === 'completed' && s.paymentRisk === 'overdue')).length;
        const money = k === 'completed'
          ? `${H.shortMoney(list.reduce((a, s) => a + H.num(s.balance), 0))} to collect`
          : H.shortMoney(list.reduce((a, s) => a + (H.num(s.netPayable) || H.num(s.total) || H.num(s.materialValue)), 0));
        const w = list.length / max * 100;
        const limit = (state.stageSla || {})[k];
        const lateText = !late ? (limit ? `Within ${plural(limit, 'day')}` : 'On time') : k === 'completed' ? `${late} payment late` : `${late} over ${plural(limit, 'day')}`;
        return `<button class="f-row st-${k} ${picked === k ? 'on' : ''}" data-stage="${k}" aria-pressed="${picked === k}">
          <span class="f-name"><i>${ic(k)}</i>${esc(sentence(stageLabel(k)))}</span>
          <span class="f-track"><span class="f-bar" style="width:${list.length ? Math.max(w, 4) : 0}%"><span class="f-late" style="width:${list.length ? late / list.length * 100 : 0}%"></span></span></span>
          <b class="f-count num">${list.length}</b>
          <span class="f-money num">${money}</span>
          <span class="f-lateText ${late ? 'slow' : ''}">${lateText}</span>
        </button>`;
      };

      const list = [...byStage[picked]].sort((a, b) => (b.attention || []).length - (a.attention || []).length || (Number(b.stageAge) || 0) - (Number(a.stageAge) || 0));
      const rowHtml = s => {
        const attn = s.attention || [];
        const flags = [];
        if (s.closed) flags.push('<span class="o-flag ok">Closed</span>');
        if (attn.includes('payment_late')) flags.push('<span class="o-flag late">Payment late</span>');
        if (attn.includes('followup_due')) flags.push(`<span class="o-flag late">Follow-up ${esc(shortDate(s.followUp && s.followUp.dueDate))}</span>`);
        if (s.blockReason) flags.push(`<span class="o-flag note">${esc((OMP.blockerLabel || H.reasonLabel)(s.blockReason))}</span>`);
        const fu = s.followUp && s.followUp.dueDate;
        const bal = H.num(s.balance);
        const slow = attn.includes('stage_days');
        return `<button class="f-item ${attn.length ? 'is-attn' : ''}" data-id="${esc(s.shipmentId)}">
          <span class="f-id"><b class="num">${esc(s.shipmentId)}</b><small class="num">${esc(s.orderId || '')}</small></span>
          <span class="f-who"><b>${esc(s.buyer || '—')}</b><small>from ${esc(s.seller || '—')}${s.material ? `, ${esc(s.material)}` : ''}</small></span>
          <span class="f-age ${slow ? 'slow' : ''}">${ic('clock')}${s.stageAge != null ? plural(s.stageAge, 'day') : '—'}</span>
          <span class="f-status">${flags.slice(0, 2).join('') || (fu ? `<span class="f-next">${ic('calendar')}Follow-up ${esc(shortDate(fu))}</span>` : '<span class="o-calm">On track</span>')}
            ${s.lastComment ? `<small class="f-last">${ic('chat')}<span>${esc(s.lastComment.text)}</span></small>` : ''}</span>
          <span class="f-owner">${ic('user')}${esc(firstNames(s.owner))}</span>
          <span class="f-bal num">${bal > 1 ? H.shortMoney(bal) : H.num(s.paidAmount) > 0 ? '<span class="o-paid">Paid</span>' : '—'}</span>
          <span class="f-go">${ic('arrow')}</span>
        </button>`;
      };

      el.innerHTML = `
        <div class="o-page f-page">
          <header class="o-head">
            <div><h1>Pipeline</h1><p>${plural(rows.length, 'active shipment')}${rejectedCount ? `, ${rejectedCount} rejected not shown` : ''}. Pick a stage to see its shipments.</p></div>
            <div class="o-head-actions">
              <label class="o-search"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="6"/><path d="m14 14 4 4"/></svg>
                <input id="pSearch" type="search" placeholder="Search shipment, SO, buyer, seller" value="${esc(search)}" /></label>
            </div>
          </header>
          <div class="o-toolbar">
            <nav class="o-scope" aria-label="Whose shipments">
              <button class="${scope === 'mine' ? 'on' : ''}" data-scope="mine">My shipments</button>
              <button class="${scope === 'all' ? 'on' : ''}" data-scope="all">All shipments</button>
            </nav>
            <div class="f-filters">
              ${scope === 'all' ? `<select id="pOwner" aria-label="Owner"><option value="">Every owner</option>${allOwners.map(n => `<option ${n === owner ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>` : ''}
              <select id="pVertical" aria-label="Vertical"><option value="">Every vertical</option>${allVerticals.map(n => `<option ${n === vertical ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
              <div class="o-quick">
                <button class="${onlyAttention ? 'on' : ''} q-attention" id="pAttn">Needs attention only</button>
                <button class="${showClosed ? 'on' : ''}" id="pClosed">Show closed</button>
              </div>
            </div>
          </div>

          <section class="o-card f-funnel" aria-label="Shipments by stage">${FLOW.map(bar).join('')}</section>

          <section class="o-card f-list">
            <header class="f-list-head">
              <h2><span class="p-stage-h st-${picked}"><i>${ic(picked)}</i>${esc(sentence(stageLabel(picked)))}</span><span class="f-list-n">${plural(list.length, 'shipment')}</span></h2>
              <p>${(state.stageSla || {})[picked] ? `Usual limit ${plural(state.stageSla[picked], 'day')}. ` : ''}Most urgent first. Click a shipment to update it.</p>
            </header>
            <div class="f-items">${list.map(rowHtml).join('') || '<p class="o-empty">No shipments at this stage right now.</p>'}</div>
          </section>
        </div>`;

      el.querySelectorAll('[data-scope]').forEach(b => b.onclick = () => { scope = b.dataset.scope; owner = ''; A.renderActive(); });
      el.querySelectorAll('.f-row').forEach(b => b.onclick = () => { picked = b.dataset.stage; A.renderActive(); });
      el.querySelector('#pAttn').onclick = () => { onlyAttention = !onlyAttention; A.renderActive(); };
      el.querySelector('#pClosed').onclick = () => { showClosed = !showClosed; A.renderActive(); };
      const po = el.querySelector('#pOwner'); if (po) po.onchange = () => { owner = po.value; A.renderActive(); };
      el.querySelector('#pVertical').onchange = e => { vertical = e.target.value; A.renderActive(); };
      const si = el.querySelector('#pSearch');
      si.oninput = () => { search = si.value; A.renderActive(); const n = document.getElementById('pSearch'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); };
      el.querySelectorAll('.f-item').forEach(b => b.onclick = () => {
        history.replaceState(null, '', '#order/' + encodeURIComponent(b.dataset.id));
        A.setView('orders');
        window.scrollTo(0, 0);
      });

      function shortDate(v) {
        if (!v) return '';
        const d = /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? new Date(v + 'T00:00:00') : new Date(v);
        return isNaN(d) ? '' : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      }
    },
  });
})();

