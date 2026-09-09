/* Page: Finance — material-cost-paid reconciliation + supplier margin agreements. */
OMP.registerPage('finance', {
  render(el, OMP) {
    const { state, helpers: H } = OMP;
    const rows = state.shipments;
    const total = rows.length;
    const materialPaidCount = rows.filter(s => H.num(s.paidAmount) >= H.num(s.materialValue) * 0.98).length;
    const totalMaterial = rows.reduce((a, s) => a + H.num(s.materialValue), 0);
    const totalGst = rows.reduce((a, s) => a + H.num(s.gst), 0);
    const totalDebitNote = rows.reduce((a, s) => a + H.num(s.debitNote), 0);
    const totalNetPayable = rows.reduce((a, s) => a + H.num(s.netPayable), 0);
    const totalPaid = rows.reduce((a, s) => a + H.num(s.paidAmount), 0);
    const paidCount = rows.filter(s => s.paymentDerived === 'paid').length;
    const tdsCount = rows.filter(s => s.tds != null).length;

    // Shipments backfilled from the lighter operational sheet tab have no
    // financial columns at all — every total above silently excludes them.
    // Surface that instead of letting the numbers look like full coverage.
    const withFinancials = rows.filter(s => H.num(s.materialValue) > 0).length;
    const missingFinancials = total - withFinancials;

    const byPaymentOwner = {};
    rows.forEach(s => {
      const owner = s.paymentOwner || 'Unassigned';
      const e = byPaymentOwner[owner] = byPaymentOwner[owner] || { owner, shipments: 0, materialValue: 0, paid: 0, balance: 0 };
      e.shipments++; e.materialValue += H.num(s.materialValue); e.balance += H.num(s.balance);
      if (s.paymentDerived === 'paid') e.paid++;
    });
    const paymentOwners = Object.values(byPaymentOwner).sort((a, b) => b.materialValue - a.materialValue);

    const bySeller = {};
    rows.forEach(s => {
      const sel = s.seller || 'Unknown';
      const e = bySeller[sel] = bySeller[sel] || { seller: sel, shipments: 0, materialValue: 0 };
      e.shipments++; e.materialValue += H.num(s.materialValue);
    });
    const sellers = Object.values(bySeller).sort((a, b) => b.materialValue - a.materialValue).slice(0, 10)
      .map(s => ({ ...s, estMargin: s.materialValue * 0.005 }));

    el.innerHTML = `
      ${missingFinancials > 0 ? `<p class="sub" style="margin:0 0 12px;padding:9px 12px;background:var(--warn-soft);color:var(--warn);border-radius:var(--r-sm)">
        ⚠ ${missingFinancials} of ${total} shipments (${Math.round(missingFinancials / total * 100)}%) have no material value / GST / payment data on file —
        every total below only reflects the ${withFinancials} shipments that do. Not a full picture of the book yet.
      </p>` : ''}
      <section class="kpi-strip" style="--kpi-cols:4">
        <article class="kpi done"><div class="kpi-head"><span class="kpi-k">Material cost paid</span></div><div class="kpi-v">${materialPaidCount}<small>of ${total}</small></div><div class="kpi-note">The main check — paid amount covers material value</div></article>
        <article class="kpi money"><div class="kpi-head"><span class="kpi-k">Total material value</span></div><div class="kpi-v" style="font-size:20px">${H.shortMoney(totalMaterial)}</div><div class="kpi-note">Across all ${total} shipments</div></article>
        <article class="kpi"><div class="kpi-head"><span class="kpi-k">Paid shipments</span></div><div class="kpi-v">${paidCount}<small>of ${total}</small></div><div class="kpi-note">Fully cleared</div></article>
        <article class="kpi warn"><div class="kpi-head"><span class="kpi-k">TDS on file</span></div><div class="kpi-v">${tdsCount}<small>of ${paidCount} paid</small></div><div class="kpi-note">Rollout gap, not an active problem</div></article>
      </section>

      <section class="card" style="margin-top:16px">
        <div class="card-head"><div><h2>Material cost reconciliation</h2><p>Material cost + GST − Debit note = Net payable, vs actually paid</p></div></div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;padding:14px 16px">
          <div class="detail num" style="flex:1;min-width:130px"><span>Material cost</span><b>${H.shortMoney(totalMaterial)}</b></div>
          <div class="detail num" style="flex:1;min-width:130px"><span>+ GST</span><b>${H.shortMoney(totalGst)}</b></div>
          <div class="detail num" style="flex:1;min-width:130px"><span>− Debit note</span><b>-${H.shortMoney(totalDebitNote)}</b></div>
          <div class="detail num" style="flex:1;min-width:130px"><span>= Net payable</span><b>${H.shortMoney(totalNetPayable)}</b></div>
          <div class="detail num" style="flex:1;min-width:130px"><span>Actually paid</span><b>${H.shortMoney(totalPaid)}</b></div>
        </div>
      </section>

      <section class="card" style="margin-top:16px">
        <div class="card-head"><div><h2>By payment owner</h2><p>Who's tracking payment follow-up on what</p></div></div>
        <table class="data-table">
          <thead><tr><th>Payment owner</th><th class="num">Shipments</th><th class="num">Material value</th><th class="num">Paid</th><th class="num">Balance open</th></tr></thead>
          <tbody>${paymentOwners.map(o => `
            <tr><td>${H.esc(o.owner)}</td><td class="num">${o.shipments}</td>
            <td class="num">${H.shortMoney(o.materialValue)}</td><td class="num">${o.paid} of ${o.shipments}</td>
            <td class="num">${H.shortMoney(o.balance)}</td></tr>`).join('')}</tbody>
        </table>
      </section>

      <section class="card" style="margin-top:16px">
        <div class="card-head"><div><h2>Supplier margin agreements</h2><p>Top 10 sellers by material value — none have a formal agreement on file yet, all default to 0.5%</p></div></div>
        <table class="data-table">
          <thead><tr><th>Seller</th><th class="num">Shipments</th><th class="num">Material value</th><th class="num">Est. margin @ 0.5%</th><th>Agreement</th></tr></thead>
          <tbody>${sellers.map(s => `
            <tr><td>${H.esc(s.seller)}</td><td class="num">${s.shipments}</td>
            <td class="num">${H.shortMoney(s.materialValue)}</td><td class="num">${H.shortMoney(s.estMargin)}</td>
            <td><span class="chip warn">No agreement on file</span></td></tr>`).join('')}</tbody>
        </table>
      </section>`;
  }
});
