/* Page: Trends — transaction volume over time (by dispatch date).
   Charts: Bar / Line (time series) + Pie (share by stage). Granularity: Daily/Weekly/Monthly.
   Range filter (default last 30 days). Charts fill the container width. All real data, no libs. */
OMP.registerPage('trends', {
  render(el, OMP) {
    const { state, helpers: H } = OMP;
    if (!state._trendGran) state._trendGran = 'day';
    if (!state._trendType) state._trendType = 'bar';
    if (!state._trendRange) state._trendRange = '30d';
    const gran = state._trendGran, type = state._trendType, range = state._trendRange;

    const parseDate = v => {
      if (!v) return null;
      const s = String(v).trim(); if (!s || s.toLowerCase() === 'na') return null;
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return new Date(s.slice(0, 10) + 'T00:00:00');
      const m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
      if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
      const d = new Date(s); return isNaN(d) ? null : d;
    };
    const pad = n => String(n).padStart(2, '0');
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const bucket = (d, g) => {
      if (g === 'month') return { key: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`, label: `${MON[d.getMonth()]} ${String(d.getFullYear()).slice(2)}` };
      if (g === 'week') { const w = new Date(d); w.setDate(w.getDate() - ((w.getDay() + 6) % 7)); return { key: `${w.getFullYear()}-${pad(w.getMonth() + 1)}-${pad(w.getDate())}`, label: `${pad(w.getDate())} ${MON[w.getMonth()]}` }; }
      return { key: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, label: `${pad(d.getDate())} ${MON[d.getMonth()]}` };
    };
    const stepPeriods = (a, b, g) => {
      const out = [];
      let d = g === 'month' ? new Date(a.getFullYear(), a.getMonth(), 1)
        : g === 'week' ? (() => { const w = new Date(a); w.setDate(w.getDate() - ((w.getDay() + 6) % 7)); return w; })()
        : new Date(a.getFullYear(), a.getMonth(), a.getDate());
      const end = new Date(b.getFullYear(), b.getMonth(), b.getDate());
      let guard = 0;
      while (d <= end && guard++ < 1200) {
        out.push(bucket(d, g));
        d = g === 'month' ? new Date(d.getFullYear(), d.getMonth() + 1, 1)
          : g === 'week' ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7)
          : new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
      }
      return out;
    };
    const granLabel = { day: 'day', week: 'week', month: 'month' }[gran];
    const RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90, all: null };
    let cutoff = null;
    if (RANGE_DAYS[range]) { cutoff = new Date(); cutoff.setHours(0, 0, 0, 0); cutoff.setDate(cutoff.getDate() - RANGE_DAYS[range]); }

    // time buckets (windowed by range)
    const map = new Map();
    let dated = 0, minD = null, maxD = null;
    for (const s of state.shipments) {
      const d = parseDate(s.dispatchDate); if (!d) continue;
      if (cutoff && d < cutoff) continue;
      dated++; if (!minD || d < minD) minD = d; if (!maxD || d > maxD) maxD = d;
      const b = bucket(d, gran);
      const row = map.get(b.key) || { key: b.key, label: b.label, count: 0, gmv: 0 };
      row.count++; row.gmv += H.num(s.total || s.materialValue); map.set(b.key, row);
    }
    const buckets = (minD && maxD ? stepPeriods(minD, maxD, gran) : []).map(p => map.get(p.key) || { key: p.key, label: p.label, count: 0, gmv: 0 });
    const max = Math.max(...buckets.map(b => b.count), 1);
    const peak = buckets.reduce((a, b) => (b.count > (a?.count || 0) ? b : a), null);
    const latest = buckets[buckets.length - 1] || { count: 0, label: '—' };
    const prev = buckets[buckets.length - 2] || { count: 0 };
    const chg = prev.count ? Math.round((latest.count - prev.count) / prev.count * 100) : (latest.count ? 100 : 0);
    const windowGmv = buckets.reduce((a, b) => a + b.gmv, 0);
    const rangeTxt = minD && maxD ? `${pad(minD.getDate())} ${MON[minD.getMonth()]} – ${pad(maxD.getDate())} ${MON[maxD.getMonth()]} ${String(maxD.getFullYear()).slice(2)}` : 'no data in range';

    // stage share (pie) — current distribution, windowed by same range
    const inWindow = state.shipments.filter(s => { if (!cutoff) return true; const d = parseDate(s.dispatchDate); return d && d >= cutoff; });
    const STAGE_COLOR = { mm: '#5b6bd6', predispatch: '#2f9e6a', intransit: '#c8962f', reached: '#d16b8a', qc: '#3f7fb8', completed: '#1f9e82', rejected: '#c0503f' };
    const stageSlices = state.stages.map(st => ({ key: st.key, label: st.label, ico: (H.STAGE_META[st.key] || {}).ico || '•', count: inWindow.filter(s => s.funnel === st.key).length, color: STAGE_COLOR[st.key] || '#888' })).filter(s => s.count > 0);
    const stageTotal = stageSlices.reduce((a, s) => a + s.count, 0);

    const rBtn = (v, l) => `<button data-r="${v}" class="${range === v ? 'on' : ''}">${l}</button>`;
    el.innerHTML = `
      <div class="trends-top">
        <div class="seg-toggle">${rBtn('7d', '7D')}${rBtn('30d', '30D')}${rBtn('90d', '90D')}${rBtn('all', 'All')}</div>
        <span class="sub">Window: <b>${rangeTxt}</b> · by dispatch date</span>
      </div>
      <div class="kpi-strip" style="--kpi-cols:4">
        <article class="kpi done"><div class="kpi-head"><span class="kpi-k">Total transactions</span><span class="kpi-meta">${range === 'all' ? 'all time' : 'last ' + RANGE_DAYS[range] + 'd'}</span></div><div class="kpi-v">${dated}</div><div class="kpi-note">Dispatched in this window</div></article>
        <article class="kpi money"><div class="kpi-head"><span class="kpi-k">Latest ${granLabel}</span><span class="kpi-meta">${latest.label}</span></div><div class="kpi-v">${latest.count}<small style="color:${chg >= 0 ? 'var(--ok)' : 'var(--bad)'}">${chg >= 0 ? '▲' : '▼'} ${Math.abs(chg)}%</small></div><div class="kpi-note">vs previous ${granLabel}</div></article>
        <article class="kpi today"><div class="kpi-head"><span class="kpi-k">Peak ${granLabel}</span><span class="kpi-meta">${peak ? peak.label : '—'}</span></div><div class="kpi-v">${peak ? peak.count : 0}</div><div class="kpi-note">Busiest ${granLabel} in range</div></article>
        <article class="kpi docs"><div class="kpi-head"><span class="kpi-k">Window GMV</span></div><div class="kpi-v" style="font-size:22px;margin-top:5px">${H.shortMoney(windowGmv)}</div><div class="kpi-note">Value dispatched in range</div></article>
      </div>
      <section class="card">
        <div class="card-head">
          <div><h2>${type === 'pie' ? 'Share by stage' : 'Transactions over time'}</h2><p>${type === 'pie' ? 'Where shipments in this window sit now' : `Dispatched each ${granLabel}`}</p></div>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <div class="seg-toggle"><button data-t="bar" class="${type === 'bar' ? 'on' : ''}">Bar</button><button data-t="line" class="${type === 'line' ? 'on' : ''}">Line</button><button data-t="pie" class="${type === 'pie' ? 'on' : ''}">Pie</button></div>
            <div class="seg-toggle" ${type === 'pie' ? 'style="opacity:.4;pointer-events:none"' : ''}><button data-g="day" class="${gran === 'day' ? 'on' : ''}">Daily</button><button data-g="week" class="${gran === 'week' ? 'on' : ''}">Weekly</button><button data-g="month" class="${gran === 'month' ? 'on' : ''}">Monthly</button></div>
          </div>
        </div>
        <div id="chartArea"></div>
      </section>
      <section class="card" style="margin-top:16px">
        <div class="card-head"><div><h2>Breakdown</h2><p>${type === 'pie' ? 'Shipments per stage' : `Count and value per ${granLabel} (latest first)`}</p></div></div>
        <div class="trend-list" id="trendList"></div>
      </section>`;

    // charts fill the measured container width
    const area = el.querySelector('#chartArea');
    const cw = Math.max(320, (area.clientWidth || 900) - 32);
    area.innerHTML = type === 'pie' ? pieHtml(stageSlices, stageTotal) : type === 'line' ? lineHtml(buckets, max, cw) : barHtml(buckets, max);

    el.querySelector('#trendList').innerHTML = type === 'pie'
      ? stageSlices.slice().sort((a, b) => b.count - a.count).map(s => `<div class="trend-row"><span class="trend-row-lab">${s.ico} ${H.esc(s.label)}</span><div class="trend-row-bar"><span style="width:${Math.round(s.count / (Math.max(...stageSlices.map(x => x.count), 1)) * 100)}%;background:${s.color}"></span></div><b class="mono">${s.count}</b><span class="sub mono">${Math.round(s.count / stageTotal * 100)}%</span></div>`).join('')
      : ([...buckets].reverse().map(b => `<div class="trend-row"><span class="trend-row-lab">${b.label}</span><div class="trend-row-bar"><span style="width:${Math.round(b.count / max * 100)}%"></span></div><b class="mono">${b.count}</b><span class="sub mono">${H.shortMoney(b.gmv)}</span></div>`).join('') || '<p class="sub" style="padding:8px">No dated transactions in this window.</p>');

    el.querySelectorAll('.seg-toggle button[data-t]').forEach(b => b.onclick = () => { state._trendType = b.dataset.t; OMP.actions.renderActive(); });
    el.querySelectorAll('.seg-toggle button[data-g]').forEach(b => b.onclick = () => { state._trendGran = b.dataset.g; OMP.actions.renderActive(); });
    el.querySelectorAll('.seg-toggle button[data-r]').forEach(b => b.onclick = () => { state._trendRange = b.dataset.r; OMP.actions.renderActive(); });

    function barHtml(bk, mx) {
      return `<div class="trend-chart">${bk.map(b => `<div class="trend-col" title="${b.label}: ${b.count}"><div class="trend-val">${b.count}</div><div class="trend-bar" style="height:${Math.max(4, Math.round(b.count / mx * 150))}px"></div><div class="trend-lab">${b.label}</div></div>`).join('') || '<p class="sub" style="padding:8px">No dated transactions in this window.</p>'}</div>`;
    }
    function lineHtml(bk, mx, W) {
      if (!bk.length) return '<p class="sub" style="padding:8px">No dated transactions in this window.</p>';
      const n = bk.length, Hh = 200, p = 30;
      const x = i => p + (n <= 1 ? (W - 2 * p) / 2 : i * (W - 2 * p) / (n - 1));
      const y = c => Hh - p - (c / mx) * (Hh - 2 * p);
      const pts = bk.map((b, i) => `${x(i).toFixed(1)},${y(b.count).toFixed(1)}`).join(' ');
      const area2 = `${x(0).toFixed(1)},${Hh - p} ${pts} ${x(n - 1).toFixed(1)},${Hh - p}`;
      const dots = bk.map((b, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(b.count).toFixed(1)}" r="3.5" fill="#0a5540"/><text x="${x(i).toFixed(1)}" y="${(y(b.count) - 9).toFixed(1)}" class="ln-val">${b.count}</text><text x="${x(i).toFixed(1)}" y="${Hh - 9}" class="ln-lab">${b.label}</text>`).join('');
      return `<div class="trend-svg-wrap"><svg viewBox="0 0 ${W} ${Hh}" width="100%" height="${Hh}" preserveAspectRatio="xMidYMid meet"><polygon points="${area2}" fill="rgba(10,85,64,.08)"/><polyline points="${pts}" fill="none" stroke="#0a5540" stroke-width="2.5" stroke-linejoin="round"/>${dots}</svg></div>`;
    }
    function pieHtml(slices, total) {
      if (!total) return '<p class="sub" style="padding:8px">No data in this window.</p>';
      const r = 58, cx = 80, cy = 80, circ = 2 * Math.PI * r; let acc = 0;
      const arcs = slices.map(s => { const dash = s.count / total * circ; const seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="26" stroke-dasharray="${dash.toFixed(2)} ${(circ - dash).toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`; acc += dash; return seg; }).join('');
      const legend = slices.slice().sort((a, b) => b.count - a.count).map(s => `<div class="pie-leg"><span class="pie-dot" style="background:${s.color}"></span><span>${s.ico} ${H.esc(s.label)}</span><b class="mono">${s.count}</b><span class="sub mono">${Math.round(s.count / total * 100)}%</span></div>`).join('');
      return `<div class="pie-wrap"><svg viewBox="0 0 160 160" width="180" height="180">${arcs}<text x="80" y="76" class="pie-total">${total}</text><text x="80" y="94" class="pie-sub">shipments</text></svg><div class="pie-legend">${legend}</div></div>`;
    }
  }
});
