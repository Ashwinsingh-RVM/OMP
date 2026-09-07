/* Page: Team & PINs — admin-only. Same /api/admin/pins used by admin-pins.html,
   now reachable as a normal tab instead of a separate linked-out page. */
OMP.registerPage('team', {
  render(el, OMP) {
    const { helpers: H } = OMP;
    const esc = H.esc;

    el.innerHTML = `
      <div class="card" style="max-width:820px;margin:0 auto">
        <div class="card-head"><div><h2>Team &amp; PINs</h2><p class="sub" style="margin-top:4px">
          Each associate signs in with their work email, then a PIN. Set it here and pass it to
          them directly — over a call or in person, not over email. Nobody, including you, can
          read back a PIN once set; if someone forgets theirs, set a new one.
        </p></div></div>
        <table class="data-table" style="margin-top:6px">
          <thead><tr><th>Work email</th><th>Role</th><th>PIN status</th><th>Set / reset</th></tr></thead>
          <tbody id="teamRows"><tr><td colspan="4">Loading…</td></tr></tbody>
        </table>
        <p class="sub" id="teamMsg" style="margin-top:10px;min-height:18px"></p>
      </div>`;

    const rows = el.querySelector('#teamRows');
    const msgEl = el.querySelector('#teamMsg');
    function say(text, ok) {
      msgEl.textContent = text;
      msgEl.style.color = ok ? 'var(--ok)' : 'var(--bad)';
    }

    function load() {
      fetch('/api/admin/pins')
        .then(r => r.json())
        .then(data => {
          if (!data || !data.roster) { say(data && data.error || 'Could not load the roster', false); return; }
          rows.innerHTML = data.roster.map(p => `
            <tr data-email="${esc(p.email)}">
              <td>${esc(p.email)}${p.internal ? `<br><span class="sub" style="font-size:12px">${esc(p.internal)}</span>` : ''}</td>
              <td><span class="chip ${p.role === 'admin' ? 'warn' : 'neutral'}">${esc(p.role)}</span></td>
              <td><span class="chip ${p.hasPin ? 'ok' : 'bad'}">${p.hasPin ? 'PIN set' : 'No PIN'}</span></td>
              <td>
                <input type="text" inputmode="numeric" maxlength="12" placeholder="6-12 digits" style="width:110px" />
                <button class="secondary-btn" data-act="set">Save</button>
                ${p.hasPin ? '<button class="secondary-btn" data-act="clear">Clear</button>' : ''}
              </td>
            </tr>`).join('');
        })
        .catch(() => say('Could not load the roster', false));
    }

    rows.onclick = (event) => {
      const btn = event.target.closest('button');
      if (!btn) return;
      const tr = btn.closest('tr');
      const email = tr.getAttribute('data-email');
      const input = tr.querySelector('input');
      const body = { email };
      if (btn.dataset.act === 'clear') {
        if (!confirm(`Clear the PIN for ${email}? They will not be able to sign in until you set a new one.`)) return;
        body.clear = true;
      } else {
        const value = input.value.trim();
        if (!/^[0-9]{6,12}$/.test(value)) { say('PIN must be 6-12 digits', false); input.focus(); return; }
        body.pin = value;
      }
      btn.disabled = true;
      fetch('/api/admin/pins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(r => r.json().then(b => ({ status: r.status, body: b })))
        .then(({ status, body: resBody }) => {
          btn.disabled = false;
          if (status === 200 && resBody.ok) {
            input.value = '';
            say(body.clear ? `PIN cleared for ${email}` : `PIN set for ${email} — pass it to them directly.`, true);
            load();
          } else {
            say(resBody.error || 'Could not update the PIN', false);
          }
        })
        .catch(() => { btn.disabled = false; say('Network error. Try again.', false); });
    };

    load();
  },
});
