/* Page: Why Pending — answers "itne shipments pending kyu hain?"
   A cause-first breakdown of every OPEN shipment. Click a cause / owner to drill
   into the CRM list filtered to it. Reads only OMP.state; rebuilds on each render. */
OMP.registerPage('insights', {
  render(el, OMP) {
    const { state, helpers: H, actions: A } = OMP;

    // one-time scoped styles for the bar rows (green, rounded, tabular-nums)
    if (!document.getElementById('insights-css')) {
      const st = document.createElement('style');
      st.id = 'insights-css';
      st.textContent = `
        .why-rows { display: grid; gap: 8px; padding: 14px 16px; }
        .why-row { display: grid; grid-template-columns: 210px 1fr auto; align-items: center;
          gap: 14px; width: 100%; text-align: left; background: var(--surface); border: 1px solid var(--line-soft);
          border-radius: var(--r-sm); padding: 11px 14px; transition: border-color .12s, background .12s, transform .06s; }
        .why-row:hover { border-color: var(--brand); background: var(--brand-soft); }
        .why-row:active { transform: translateY(1px); }
        .why-lab { font-size: 12.5px; font-weight: 600; color: var(--ink); line-height: 1.3; }
        .why-lab .sub { display: block; font-weight: 500; margin-top: 1px; }
        .why-track { position: relative; height: 30px; background: var(--surface-2); border-radius: 999px; overflow: hidden; }
        .why-fill { position: absolute; inset: 0 auto 0 0; background: linear-gradient(90deg, var(--brand), var(--brand-deep));
          border-radius: 999px; min-width: 8px; display: flex; align-items: center; }
        .why-fill b { font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 15px; font-weight: 700;
          color: #fff; padding: 0 12px; line-height: 1; }
        .why-fill.thin b { color: var(--brand); position: absolute; left: 100%; margin-left: 8px; }
        .why-right { text-align: right; min-width: 118px; }
        .why-right .n { font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 15px; font-weight: 700; color: var(--ink); }
        .why-right .m { display: block; font-size: 11px; color: var(--muted); margin-top: 1px; }
        .brk-rows { display: grid; gap: 6px; padding: 14px 16px; }
        .brk-row { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 12px;
          width: 100%; text-align: left; background: transparent; border: 0; border-bottom: 1px solid var(--line-soft); padding: 9px 2px; }
        .brk-row:last-child { border-bottom: 0; }
        .brk-row:hover { background: var(--surface-2); }
        .brk-ico { font-size: 18px; width: 24px; text-align: center; }
        .brk-lab { font-size: 12.5px; font-weight: 600; color: var(--ink); }
        .brk-lab .sub { display: block; font-weight: 500; margin-top: 1px; }
        .brk-n { font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 16px; font-weight: 700; color: var(--brand); text-align: right; }
        @media (max-width: 640px) { .why-row { grid-template-columns: 1fr; gap: 8px; } .why-right { text-align: left; } }
      `;
      document.head.appendChild(st);
    }

    const isOpen = s => s.funnel !== 'completed' && s.funnel !== 'rejected';
    const open = state.shipments.filter(isOpen);
    const openBal = open.reduce((a, s) => a + H.num(s.balance), 0);
    const proofN = open.filter(s => s.paidProofPending).length;

    // ── group OPEN shipments by cause ──
    const byCause = {};
    open.forEach(s => {
      const c = s.cause || 'in_progress';
      (byCause[c] = byCause[c] || { count: 0, bal: 0 }).count++;
      byCause[c].bal += H.num(s.balance);
    });
    const causeRows = Object.entries(byCause)
      .map(([code, v]) => ({ code, ...v }))
      .sort((a, b) => b.count - a.count);
    const maxCount = Math.max(...causeRows.map(r => r.count), 1);

    el.innerHTML = `
      <section class="kpi-strip" style="--kpi-cols:3">
        <div class="kpi block">
          <div class="kpi-head"><span class="kpi-k">Open shipments</span></div>
          <div class="kpi-v">${open.length}</div>
          <div class="kpi-note">Not yet completed or rejected — still moving through the funnel.</div>
        </div>
        <div class="kpi money">
          <div class="kpi-head"><span class="kpi-k">Balance stuck</span></div>
          <div class="kpi-v">${H.shortMoney(openBal)}</div>
          <div class="kpi-note">Sum of open balance across all pending shipments.</div>
        </div>
        <div class="kpi today">
          <div class="kpi-head"><span class="kpi-k">Paid · proof pending</span></div>
          <div class="kpi-v">${proofN}</div>
          <div class="kpi-note">Payment cleared but UTR / advice not uploaded in system.</div>
        </div>
      </section>

      <section class="card" style="margin-top:16px">
        <div class="card-head"><div><h2>Why are these pending?</h2>
          <p>Every open shipment, grouped by its primary cause — click a row to see them in CRM</p></div>
          <span class="chip neutral">${open.length} open</span></div>
        <div class="why-rows" id="whyRows"></div>
      </section>

      <section class="grid-2" style="margin-top:16px">
        <div class="card">
          <div class="card-head"><div><h2>Stuck by stage</h2><p>Where in the funnel the pending sit</p></div></div>
          <div class="brk-rows" id="stageRows"></div>
        </div>
        <div class="card">
          <div class="card-head"><div><h2>By owner</h2><p>Top owners by pending count · balance stuck</p></div></div>
          <div class="brk-rows" id="ownerRows"></div>
        </div>
      </section>`;

    // ── PRIMARY: cause bars ──
    const whyEl = el.querySelector('#whyRows');
    if (!causeRows.length) {
      whyEl.innerHTML = '<p class="sub" style="padding:4px 2px">Nothing pending — every shipment is closed. 🎉</p>';
    } else {
      whyEl.innerHTML = causeRows.map(r => {
        const pctOpen = Math.round(r.count / open.length * 100);
        const w = Math.max(6, Math.round(r.count / maxCount * 100));
        const thin = w < 22; // put the count outside the bar when it's too short to hold text
        return `
          <button class="why-row" data-cause="${H.esc(r.code)}" title="Open ${H.num(r.count)} shipments in CRM">
            <span class="why-lab">${H.esc(H.causeLabel(r.code))}<span class="sub">${pctOpen}% of open</span></span>
            <span class="why-track"><span class="why-fill${thin ? ' thin' : ''}" style="width:${w}%"><b>${r.count}</b></span></span>
            <span class="why-right"><span class="n">${H.shortMoney(r.bal)}</span><span class="m">balance stuck</span></span>
          </button>`;
      }).join('');
      whyEl.querySelectorAll('.why-row').forEach(b => b.onclick = () => {
        state.filters = { search: '', stage: '', risk: '', cause: b.dataset.cause };
        A.setView('crm');
      });
    }

    // ── SECONDARY (a): by stage ──
    const stageEl = el.querySelector('#stageRows');
    const openStages = state.stages.filter(st => st.key !== 'completed' && st.key !== 'rejected');
    const sCount = {}; open.forEach(s => sCount[s.funnel] = (sCount[s.funnel] || 0) + 1);
    const stageList = openStages
      .map(st => ({ st, n: sCount[st.key] || 0 }))
      .filter(x => x.n > 0)
      .sort((a, b) => b.n - a.n);
    stageEl.innerHTML = stageList.length
      ? stageList.map(({ st, n }) => {
          const m = H.STAGE_META[st.key] || { ico: '•' };
          return `<button class="brk-row" data-stage="${H.esc(st.key)}">
            <span class="brk-ico">${m.ico}</span>
            <span class="brk-lab">${H.esc(st.label)}</span>
            <span class="brk-n">${n}</span></button>`;
        }).join('')
      : '<p class="sub" style="padding:4px 2px">No pending shipments in any stage.</p>';
    stageEl.querySelectorAll('.brk-row').forEach(b => b.onclick = () => {
      state.filters = { search: '', stage: b.dataset.stage, risk: '', cause: '' };
      A.setView('crm');
    });

    // ── SECONDARY (b): by owner ──
    const ownerEl = el.querySelector('#ownerRows');
    const byOwner = {};
    open.forEach(s => {
      const o = (s.owner || '').trim() || 'Unassigned';
      (byOwner[o] = byOwner[o] || { count: 0, bal: 0 }).count++;
      byOwner[o].bal += H.num(s.balance);
    });
    const ownerRows = Object.entries(byOwner)
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
    ownerEl.innerHTML = ownerRows.length
      ? ownerRows.map(r => `<div class="brk-row">
          <span class="brk-ico">👤</span>
          <span class="brk-lab">${H.esc(r.name)}<span class="sub">${H.shortMoney(r.bal)} stuck</span></span>
          <span class="brk-n">${r.count}</span></div>`).join('')
      : '<p class="sub" style="padding:4px 2px">No owners with pending shipments.</p>';
  }
});
