/* Page: Activity — who signed in, who changed what. Restricted server-side
   (and hidden in the nav) to one specific person, not "any admin". */
OMP.registerPage('activity', {
  render(el, OMP) {
    const { helpers: H } = OMP;
    const esc = H.esc;

    el.innerHTML = `
      <div class="crm-layout">
        <div class="card">
          <div class="card-head"><div><h2>Sign-ins</h2><p class="sub" style="margin-top:4px">Most recent first</p></div></div>
          <div id="loginFeed" style="padding:6px 14px 14px">Loading…</div>
        </div>
        <div class="card span-2">
          <div class="card-head"><div><h2>Update Activity</h2><p class="sub" style="margin-top:4px">Every change logged across all shipments</p></div></div>
          <div id="updateFeed" style="padding:6px 14px 14px">Loading…</div>
        </div>
      </div>`;

    const loginEl = el.querySelector('#loginFeed');
    const updateEl = el.querySelector('#updateFeed');
    const fmt = (iso) => {
      const d = new Date(iso);
      return isNaN(d) ? esc(iso) : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    };

    fetch('/api/admin/activity')
      .then(r => r.json())
      .then(data => {
        if (!data || !data.ok) {
          loginEl.textContent = updateEl.textContent = (data && data.error) || 'Could not load activity.';
          return;
        }
        loginEl.innerHTML = data.logins.length
          ? data.logins.map(e => `<div class="tiny-row" style="padding:6px 0;border-bottom:1px solid var(--line)"><b>${esc(e.email)}</b><span class="sub" style="margin-left:8px">${fmt(e.at)}</span></div>`).join('')
          : '<p class="sub">No sign-ins recorded yet.</p>';
        updateEl.innerHTML = data.updates.length
          ? `<div style="overflow-x:auto"><table class="data-table"><thead><tr><th>When</th><th>Who</th><th>Shipment</th><th>Buyer</th><th>Change</th></tr></thead><tbody>${
              data.updates.map(e => `<tr>
                <td>${fmt(e.at)}</td>
                <td>${esc(e.actor || e.actorEmail || '—')}</td>
                <td>${esc(e.shipmentId)}</td>
                <td>${esc(e.buyer || '—')}</td>
                <td>${esc(e.type)}${e.key ? ' · ' + esc(e.key) : ''}${e.value ? ' → ' + esc(e.value) : ''}</td>
              </tr>`).join('')
            }</tbody></table></div>`
          : '<p class="sub">No activity recorded yet.</p>';
      })
      .catch(() => { loginEl.textContent = updateEl.textContent = 'Could not load activity.'; });
  },
});
