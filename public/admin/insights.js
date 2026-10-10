'use strict';

// Admin views for the back office: Customers (CRM + loyalty), Menu
// (dish editing, one-click price changes) and Analytics. Stock and outlet
// logins are in control.js.
// Loaded after staff/panel.js; uses its api(), state, rupees(), esc() helpers.

(() => {
  const $ = (id) => document.getElementById(id);
  const num = (n) => Number(n || 0).toLocaleString('en-IN');
  const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
  const short = (name) => BRAND.short(String(name || ''));
  const outletName = (id) => short(window.RCAdmin.state.outlets.find((o) => o.id === id)?.name || '—');
  const dateFmt = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' }) : '—');
  // esc() and rupees() come from staff/panel.js.
  const kRupees = (p) => {
    const r = p / 100;
    if (r >= 1e7) return `₹${(r / 1e7).toFixed(1)}Cr`;
    if (r >= 1e5) return `₹${(r / 1e5).toFixed(1)}L`;
    if (r >= 1e3) return `₹${(r / 1e3).toFixed(1)}k`;
    return `₹${Math.round(r)}`;
  };

  // ---- Shared bits ------------------------------------------------------

  // One tooltip for every chart; marks carry data-tip / data-tip-title.
  const tip = document.createElement('div');
  tip.className = 'viz-tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.appendChild(tip);
  function showTip(el, x, y) {
    tip.replaceChildren();
    const v = document.createElement('b');
    v.textContent = el.dataset.tip;
    const l = document.createElement('span');
    l.textContent = el.dataset.tipTitle || '';
    tip.append(v, l);
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(window.innerWidth - r.width - 8, Math.max(8, x + 12))}px`;
    tip.style.top = `${Math.max(8, y - r.height - 12)}px`;
  }
  document.addEventListener('pointermove', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (el) showTip(el, e.clientX, e.clientY); else tip.hidden = true;
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (!el) return;
    const r = el.getBoundingClientRect();
    showTip(el, r.left + r.width / 2, r.top);
  });
  document.addEventListener('focusout', () => { tip.hidden = true; });

  function download(filename, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const csv = (rows) => rows.map((r) => r.map((v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''))).join(',')).join('\n') + '\n';

  // Horizontal magnitude bars as rows: label · bar · value. Values are text, so
  // nothing depends on hover.
  function barList(rows, { value, label, sub, fmt, max, tipTitle }) {
    const top = max ?? Math.max(1, ...rows.map(value));
    return `<div class="hbars">${rows.map((r) => `
      <div class="hbar" tabindex="0" data-tip="${esc(fmt(value(r)))}" data-tip-title="${esc(tipTitle ? tipTitle(r) : label(r))}">
        <span class="hb-label">${esc(label(r))}${sub ? `<small>${esc(sub(r))}</small>` : ''}</span>
        <span class="hb-track"><span class="hb-fill" style="width:${Math.max(0.5, (value(r) / top) * 100)}%"></span></span>
        <span class="hb-value">${esc(fmt(value(r)))}</span>
      </div>`).join('')}</div>`;
  }

  // ---- Analytics ----------------------------------------------------------

  const A = { preset: '30', from: '', to: '', channel: '', fulfilment: '', itemSort: 'revenue', data: null };
  const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const shift = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

  function range() {
    const today = istToday();
    if (A.preset === 'custom' && A.from && A.to) return { from: A.from, to: A.to };
    if (A.preset === 'today') return { from: today, to: today };
    if (A.preset === 'month') return { from: `${today.slice(0, 8)}01`, to: today };
    return { from: shift(today, -(Number(A.preset) - 1)), to: today };
  }

  function delta(change, { goodWhenUp = true } = {}) {
    if (change == null || !Number.isFinite(change)) return '<span class="delta muted">no earlier data</span>';
    if (Math.abs(change) < 0.005) return '<span class="delta muted">→ no change</span>';
    const up = change > 0;
    const good = up === goodWhenUp;
    return `<span class="delta ${good ? 'good' : 'bad'}">${up ? '▲' : '▼'} ${pct(Math.abs(change), Math.abs(change) < 0.1 ? 1 : 0)}</span>`;
  }

  function tiles(d) {
    const s = d.summary;
    const c = d.change;
    const t = (label, value, ch, note, opts) => `<div class="tile"><span class="t-label">${label}</span><span class="t-value">${value}</span><span class="t-foot">${delta(ch, opts)}${note ? ` <span class="muted">${note}</span>` : ''}</span></div>`;
    return `<div class="tiles">
      ${t('Gross sales', rupees(s.grossSales), c.grossSales, 'incl. GST & delivery')}
      ${t('Orders', num(s.orders), c.orders)}
      ${t('Average order', rupees(s.aov), c.aov)}
      ${t('Customers', num(s.customers), c.customers, `${num(s.newCustomers)} new · ${num(s.returningCustomers)} returning`)}
      ${t('Item sales', rupees(s.itemSales), c.itemSales, 'food only')}
      ${t('Cancelled', `${num(s.cancelled)} <small>(${pct(s.cancelRate, 1)})</small>`, c.cancelRate, '', { goodWhenUp: false })}
      ${t('Delivery charges', rupees(s.deliveryFees), c.deliveryFees, `${num(s.deliveryOrders)} deliveries · avg ${s.avgDeliveryKm} km`)}
      ${t('GST collected', rupees(s.gst), c.gst)}
    </div>`;
  }

  // Columns on one axis: rows [{ value, label, tick, tipTitle, tip }].
  function columns(rows, { aria, fmt = kRupees, everyLabel }) {
    const W = 760; const H = 240; const L = 56; const R = 12; const T = 14; const B = 30;
    const max = Math.max(1, ...rows.map((r) => r.value));
    const raw = fmt === kRupees ? max / 100 : max;
    const step = 10 ** Math.floor(Math.log10(raw / 4 || 1));
    const nice = [1, 2, 2.5, 5, 10].map((m) => m * step).find((s) => raw / s <= 4) || step * 10;
    const unit = fmt === kRupees ? 100 : 1;
    const top = Math.max(nice, Math.ceil(raw / nice) * nice) * unit;
    const y = (v) => T + (H - T - B) * (1 - v / top);
    const bw = (W - L - R) / rows.length;
    const ticks = [];
    for (let v = 0; v <= top + 1e-9; v += nice * unit) ticks.push(v);
    const every = everyLabel || Math.ceil(rows.length / 8);
    return `<svg class="trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}">
      ${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="${v ? 'grid' : 'base'}"/><text x="${L - 8}" y="${y(v) + 4}" class="tick" text-anchor="end">${fmt === kRupees ? kRupees(v) : num(Math.round(v))}</text>`).join('')}
      ${rows.map((d, i) => {
        const h = Math.max(d.value ? 2 : 0, y(0) - y(d.value));
        const x = L + i * bw + 1;
        const w = Math.max(1, bw - 2);
        const r = Math.min(4, w / 2, h);
        const path = h ? `M${x} ${y(0)}V${y(0) - h + r}Q${x} ${y(0) - h} ${x + r} ${y(0) - h}H${x + w - r}Q${x + w} ${y(0) - h} ${x + w} ${y(0) - h + r}V${y(0)}Z` : '';
        return `<g class="col" tabindex="0" data-tip="${esc(d.tip)}" data-tip-title="${esc(d.tipTitle)}">
          <rect x="${L + i * bw}" y="${T}" width="${bw}" height="${H - T - B}" class="hit"/>
          ${path ? `<path d="${path}" class="bar${d.peak ? ' peak' : ''}"/>` : ''}
          ${i % every === 0 ? `<text x="${x + w / 2}" y="${H - 10}" class="tick" text-anchor="middle">${esc(d.tick)}</text>` : ''}
        </g>`;
      }).join('')}
    </svg>`;
  }

  function trendChart(daily) {
    return columns(daily.map((d) => ({
      value: d.sales, tick: dateFmt(`${d.date}T06:30:00Z`), tip: `${rupees(d.sales)} · ${d.orders} orders`,
      tipTitle: new Date(`${d.date}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', weekday: 'short', timeZone: 'UTC' }),
    })), { aria: 'Daily gross sales' });
  }

  const hh = (h) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;
  function rushChart(hourly) {
    const peak = Math.max(...hourly.map((h) => h.orders));
    return columns(hourly.map((h) => ({
      value: h.orders, peak: peak && h.orders === peak, tick: hh(h.hour), tip: `${num(h.orders)} orders · ${rupees(h.sales)}`, tipTitle: `${hh(h.hour)}–${hh((h.hour + 1) % 24)}`,
    })), { aria: 'Orders by hour of day', fmt: num, everyLabel: 3 });
  }

  const minFmt = (m) => (m == null ? '—' : `${Math.round(m)} min`);
  const starText = (avg, n) => (avg == null ? '<span class="muted">—</span>' : `★ ${avg.toFixed(1)} <span class="small muted">(${num(n)})</span>`);

  // Star ratings collected on WhatsApp after delivery.
  function reviewsSection(r) {
    const dist = barList(r.distribution, { value: (x) => x.count, label: (x) => `${x.stars} star${x.stars > 1 ? 's' : ''}`, fmt: (v) => num(v), tipTitle: (x) => `${x.stars}-star reviews` });
    return `<section class="card"><header><h3>Reviews</h3><span class="muted small">Asked on WhatsApp 30 min after delivery · 1–5 stars</span><button type="button" class="link" data-csv="ratings">Export CSV</button></header>
      <div class="tiles">
        <div class="tile"><span class="t-label">Average rating</span><span class="t-value">${r.average == null ? '—' : `★ ${r.average.toFixed(2)}`}</span><span class="t-foot muted">whole order</span></div>
        <div class="tile"><span class="t-label">Reviews</span><span class="t-value">${num(r.count)}</span><span class="t-foot muted">${pct(r.responseRate)} of completed orders</span></div>
      </div>
      <div class="two">
        <div><h4>Rating spread</h4>${dist}</div>
        <div><h4>By outlet</h4><div class="table-wrap"><table class="data"><tbody>
          ${r.byOutlet.map((o) => `<tr><td>${esc(short(o.name))}</td><td class="n">${starText(o.average, o.count)}</td></tr>`).join('')}
        </tbody></table></div></div>
      </div>
      <h4>Dish ratings</h4>
      <div class="table-wrap"><table class="data"><thead><tr><th>Dish</th><th class="n">Average</th><th class="n">Ratings</th><th class="n">1–2 stars</th></tr></thead><tbody>
        ${r.byItem.map((i) => `<tr><td>${esc(i.name)}</td><td class="n">★ ${i.average.toFixed(2)}</td><td class="n">${num(i.count)}</td><td class="n">${i.low ? `<b class="delta bad">${num(i.low)}</b>` : '0'}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No dish ratings yet.</td></tr>'}
      </tbody></table></div>
      <h4>What customers said</h4>
      <div class="table-wrap"><table class="data"><tbody>
        ${r.comments.map((c) => `<tr><td>${c.stars != null ? `★ ${c.stars} · ` : ''}${esc(c.comment)}<br><span class="small muted">${esc(c.name || '')} · ${esc(c.code || '')} · ${esc(outletName(c.outletId))} · ${esc(dateFmt(c.at))}</span></td></tr>`).join('') || '<tr><td class="muted">No comments yet.</td></tr>'}
      </tbody></table></div>
    </section>`;
  }

  function heatmap(m) {
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const max = Math.max(1, ...m.flat());
    const level = (n) => (n ? Math.min(7, 1 + Math.floor((n / max) * 6.999)) : 0);
    const hours = [...Array(24).keys()];
    return `<div class="heat" role="table" aria-label="Orders by weekday and hour">
      <span></span>${hours.map((h) => `<span class="hh">${h % 3 === 0 ? hh(h) : ''}</span>`).join('')}
      ${m.map((row, d) => `<span class="hd">${days[d]}</span>${row.map((n, h) => `<span class="cell l${level(n)}" tabindex="0" data-tip="${n} order${n === 1 ? '' : 's'}" data-tip-title="${days[d]} ${hh(h)}–${hh((h + 1) % 24)}"></span>`).join('')}`).join('')}
    </div>
    <div class="heat-key"><span>Fewer</span>${[1, 2, 3, 4, 5, 6, 7].map((l) => `<span class="cell l${l}"></span>`).join('')}<span>More orders</span></div>`;
  }

  function itemsTable(items) {
    const key = { revenue: (r) => r.revenue, qty: (r) => r.qty, orders: (r) => r.orders }[A.itemSort];
    const rows = [...items].sort((a, b) => key(b) - key(a));
    return `<div class="table-wrap"><table class="data">
      <thead><tr><th>#</th><th>Dish</th><th>Category</th><th class="n">Qty sold</th><th class="n">Revenue</th><th class="n">Share</th><th class="n">In % of orders</th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr><td class="n">${i + 1}</td><td><span class="vegmark ${r.veg ? '' : 'non'}"></span>${esc(r.name)}</td><td>${esc(r.category)}</td>
        <td class="n">${num(r.qty)}</td><td class="n">${rupees(r.revenue)}</td><td class="n">${pct(r.share, 1)}</td><td class="n">${pct(r.attachRate, 1)}</td></tr>`).join('')}</tbody>
    </table></div>`;
  }

  async function renderAnalytics(ctx) {
    const r = range();
    const q = new URLSearchParams({ from: r.from, to: r.to });
    if (ctx.state.outletId) q.set('outletId', ctx.state.outletId);
    if (A.channel) q.set('channel', A.channel);
    if (A.fulfilment) q.set('fulfilment', A.fulfilment);
    const view = $('view');
    view.classList.add('loading');
    const d = await ctx.api('/analytics?' + q);
    view.classList.remove('loading');
    A.data = d;
    const prevDays = d.range.days === 1 ? 'the day before' : `previous ${d.range.days} days`;
    view.innerHTML = `
      <div class="filters" role="group" aria-label="Analytics filters">
        <div class="seg">${[['today', 'Today'], ['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['month', 'This month'], ['custom', 'Custom']]
          .map(([k, l]) => `<button type="button" data-preset="${k}" class="${A.preset === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        <span class="${A.preset === 'custom' ? '' : 'hidden'}"><input type="date" id="aFrom" value="${esc(A.from || r.from)}"> – <input type="date" id="aTo" value="${esc(A.to || r.to)}"></span>
        <select id="aChannel" aria-label="Channel"><option value="">All channels</option><option value="whatsapp" ${A.channel === 'whatsapp' ? 'selected' : ''}>WhatsApp</option><option value="web" ${A.channel === 'web' ? 'selected' : ''}>Web app</option></select>
        <select id="aFulfil" aria-label="Order type"><option value="">Delivery + pickup</option><option value="delivery" ${A.fulfilment === 'delivery' ? 'selected' : ''}>Delivery</option><option value="pickup" ${A.fulfilment === 'pickup' ? 'selected' : ''}>Pickup</option></select>
        <span class="muted small">${esc(dateFmt(`${d.range.from}T06:30:00Z`))} – ${esc(dateFmt(`${d.range.to}T06:30:00Z`))} · ${ctx.state.outletId ? esc(outletName(Number(ctx.state.outletId))) : 'All outlets'} · changes vs ${prevDays}</span>
      </div>
      ${tiles(d)}
      <section class="card"><header><h3>Daily sales</h3><span class="muted small">Gross sales per day. Hover a day for orders.</span></header>${trendChart(d.daily)}</section>
      <div class="two">
        <section class="card"><header><h3>Outlet-wise sales</h3><button type="button" class="link" data-csv="outlets">Export CSV</button></header>
          ${barList(d.outlets, { value: (o) => o.sales, label: (o) => short(o.name), sub: (o) => `${num(o.orders)} orders · avg ${rupees(o.aov)} · ${pct(o.share)}`, fmt: rupees })}
        </section>
        <section class="card"><header><h3>Category mix</h3></header>
          ${barList(d.categories, { value: (c) => c.revenue, label: (c) => c.category, sub: (c) => `${num(c.qty)} sold · ${pct(c.share)}`, fmt: rupees })}
        </section>
      </div>
      <section class="card"><header><h3>Most popular dishes</h3><span class="muted small">Top 10 by revenue</span></header>
        ${barList(d.items.slice(0, 10), { value: (i) => i.revenue, label: (i) => `${i.rank}. ${i.name}`, sub: (i) => `${num(i.qty)} sold · in ${pct(i.attachRate)} of orders`, fmt: rupees })}
      </section>
      <section class="card"><header><h3>Rush hours</h3><span class="muted small">Orders by hour of day (IST); the busiest hour is darker</span></header>
        ${rushChart(d.rush.hourly)}
        <div class="two" style="margin-top:12px">
          <div><h4>Busiest slots</h4><div class="table-wrap"><table class="data"><tbody>
            ${d.rush.busiestSlots.map((x, i) => `<tr><td>${i + 1}. ${esc(x.day)} ${hh(x.hour)}–${hh((x.hour + 1) % 24)}</td><td class="n">${num(x.orders)} orders</td></tr>`).join('') || '<tr><td class="muted">No orders.</td></tr>'}
          </tbody></table></div></div>
          <div><h4>Peak hour by outlet</h4><div class="table-wrap"><table class="data"><tbody>
            ${d.rush.outletPeaks.map((p) => `<tr><td>${esc(short(p.name))}</td><td class="n">${p.peakHour == null ? '—' : `${hh(p.peakHour)} · ${num(p.peakOrders)} orders`}</td></tr>`).join('')}
          </tbody></table></div></div>
        </div>
      </section>
      <section class="card"><header><h3>Kitchen and delivery speed</h3><span class="muted small">From order status times · ${num(d.speed.measured)} orders measured</span></header>
        <div class="tiles">
          <div class="tile"><span class="t-label">Time to accept</span><span class="t-value">${minFmt(d.speed.acceptMin)}</span></div>
          <div class="tile"><span class="t-label">Kitchen prep</span><span class="t-value">${minFmt(d.speed.prepMin)}</span><span class="t-foot muted">accepted → ready / rider picks up</span></div>
          <div class="tile"><span class="t-label">Delivery ride</span><span class="t-value">${minFmt(d.speed.rideMin)}</span></div>
          <div class="tile"><span class="t-label">Order to doorstep</span><span class="t-value">${minFmt(d.speed.totalDeliveryMin)}</span></div>
        </div>
        <div class="two">
          <div><h4>By hour: does the rush slow us down?</h4><div class="table-wrap"><table class="data"><thead><tr><th>Hour</th><th class="n">Orders</th><th class="n">Prep</th><th class="n">Order to door</th></tr></thead><tbody>
            ${d.speed.byHour.filter((h) => h.orders).map((h) => `<tr><td>${hh(h.hour)}</td><td class="n">${num(h.orders)}</td><td class="n">${minFmt(h.prepMin)}</td><td class="n">${minFmt(h.totalMin)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No orders.</td></tr>'}
          </tbody></table></div></div>
          <div><h4>By outlet</h4><div class="table-wrap"><table class="data"><thead><tr><th>Outlet</th><th class="n">Prep</th><th class="n">Order to door</th></tr></thead><tbody>
            ${d.speed.byOutlet.map((o) => `<tr><td>${esc(short(o.name))}</td><td class="n">${minFmt(o.prepMin)}</td><td class="n">${minFmt(o.totalMin)}</td></tr>`).join('')}
          </tbody></table></div></div>
        </div>
      </section>
      <section class="card"><header><h3>When orders come in</h3><span class="muted small">Orders by weekday and hour (IST)</span></header>${heatmap(d.heatmap)}</section>
      ${reviewsSection(d.reviews)}
      <section class="card"><header><h3>Ordered together</h3><span class="muted small">Dish pairs in the same order: ideas for combos and offers</span><button type="button" class="link" data-csv="combos">Export CSV</button></header>
        <div class="table-wrap"><table class="data"><thead><tr><th>Combination</th><th class="n">Orders</th><th class="n">% of all orders</th><th class="n">Takers of 1st also take 2nd</th><th class="n">Revenue</th><th class="n">Order rating</th></tr></thead><tbody>
          ${d.combinations.map((c) => `<tr><td>${esc(c.items[0])} <b>+</b> ${esc(c.items[1])}</td><td class="n">${num(c.orders)}</td><td class="n">${pct(c.share, 1)}</td><td class="n">${pct(c.withA)}</td><td class="n">${rupees(c.revenue)}</td><td class="n">${starText(c.rating, c.ratings)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Not enough orders with two or more dishes yet.</td></tr>'}
        </tbody></table></div>
      </section>
      <div class="three">
        ${[['Channel', d.channels], ['Payment', d.payments], ['Order type', d.fulfilment]].map(([t, rows]) => `<section class="card"><header><h3>${t}</h3></header>
          ${rows.length ? barList(rows, { value: (x) => x.sales, label: (x) => x.label, sub: (x) => `${num(x.orders)} orders`, fmt: rupees }) : '<p class="muted">No orders.</p>'}</section>`).join('')}
      </div>
      <section class="card"><header><h3>Item-wise sales</h3>
        <span><label class="small">Sort <select id="aItemSort"><option value="revenue" ${A.itemSort === 'revenue' ? 'selected' : ''}>Revenue</option><option value="qty" ${A.itemSort === 'qty' ? 'selected' : ''}>Quantity</option><option value="orders" ${A.itemSort === 'orders' ? 'selected' : ''}>Orders</option></select></label>
        <button type="button" class="link" data-csv="items">Export CSV</button></span></header>
        ${itemsTable(d.items)}
        ${d.notSold.length ? `<p class="small muted" style="margin-top:10px"><b>Didn't sell in this period:</b> ${d.notSold.map((i) => esc(i.name)).join(', ')}</p>` : ''}
      </section>
      <div class="two">
        <section class="card"><header><h3>Top customers</h3><button type="button" class="link" data-goto="customers">Open CRM</button></header>
          <div class="table-wrap"><table class="data"><thead><tr><th>Customer</th><th class="n">Orders</th><th class="n">Spent</th></tr></thead>
          <tbody>${d.topCustomers.map((c) => `<tr><td>${esc(c.name)}<br><span class="small muted">${esc(c.phone)}</span></td><td class="n">${c.orders}</td><td class="n">${rupees(c.spent)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No orders.</td></tr>'}</tbody></table></div>
        </section>
        <section class="card"><header><h3>Money breakdown</h3></header>
          <div class="table-wrap"><table class="data"><tbody>
            <tr><td>Item sales</td><td class="n">${rupees(d.summary.itemSales)}</td></tr>
            <tr><td>Packing</td><td class="n">${rupees(d.summary.packing)}</td></tr>
            <tr><td>GST</td><td class="n">${rupees(d.summary.gst)}</td></tr>
            <tr><td>Delivery charges</td><td class="n">${rupees(d.summary.deliveryFees)}</td></tr>
            <tr><th>Gross sales</th><th class="n">${rupees(d.summary.grossSales)}</th></tr>
            <tr><td>Confirmed UPI payments</td><td class="n">${rupees(d.summary.upiPaid)}</td></tr>
          </tbody></table></div>
        </section>
      </div>`;
  }

  // ---- Customers (CRM) ----------------------------------------------------

  const C = { q: '', segment: 'all', optIn: false, sort: 'last', open: null };

  function customersQuery(ctx) {
    const q = new URLSearchParams({ segment: C.segment, sort: C.sort });
    if (C.q) q.set('q', C.q);
    if (C.optIn) q.set('optIn', '1');
    if (ctx.state.outletId) q.set('outletId', ctx.state.outletId);
    return q;
  }

  async function renderCustomers(ctx) {
    if (document.activeElement?.closest?.('#crmDetail form')) return;
    const d = await ctx.api('/customers?' + customersQuery(ctx));
    const segs = Object.entries(d.segments);
    $('view').innerHTML = `
      <div class="filters">
        <input id="cSearch" type="search" placeholder="Search name or phone" value="${esc(C.q)}" style="max-width:240px">
        <div class="seg">${segs.map(([k, l]) => `<button type="button" data-seg="${k}" class="${C.segment === k ? 'on' : ''}" title="${esc(l)}">${esc(l.split(' (')[0])} <small>${d.counts[k]}</small></button>`).join('')}</div>
        <label class="small"><input type="checkbox" id="cOptIn" ${C.optIn ? 'checked' : ''} style="width:auto"> Opted in to offers</label>
        <select id="cSort" aria-label="Sort"><option value="last">Last order</option><option value="spent" ${C.sort === 'spent' ? 'selected' : ''}>Total spent</option><option value="orders" ${C.sort === 'orders' ? 'selected' : ''}>Orders</option><option value="points" ${C.sort === 'points' ? 'selected' : ''}>Points</option></select>
        <button type="button" class="btn secondary" style="width:auto" id="cExport">Export for campaign (${d.total})</button>
      </div>
      <p class="small muted">Saved automatically from every web and WhatsApp order. Loyalty: 1 point for every ₹100 of a completed order. Only message customers who opted in.</p>
      <div class="table-wrap"><table class="data clickable">
        <thead><tr><th>Customer</th><th class="n">Orders</th><th class="n">Spent</th><th class="n">Avg order</th><th>Last order</th><th class="n">Points</th><th>Segments</th><th>Offers</th></tr></thead>
        <tbody>${d.customers.map((c) => `<tr data-customer="${esc(c.phone)}" tabindex="0">
          <td><b>${esc(c.name || '—')}</b><br><span class="small muted">${esc(c.phone)} · ${esc(outletName(c.outletId))}</span></td>
          <td class="n">${c.orders}</td><td class="n">${rupees(c.spent)}</td><td class="n">${rupees(c.avgOrder)}</td>
          <td>${esc(dateFmt(c.lastOrderAt))}${c.daysSinceLast != null ? `<br><span class="small muted">${c.daysSinceLast === 0 ? 'today' : `${c.daysSinceLast}d ago`}</span>` : ''}</td>
          <td class="n">${num(c.points)}</td>
          <td>${c.segments.map((s) => `<span class="chip seg-${s}">${esc(s)}</span>`).join(' ')}${c.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join(' ')}</td>
          <td>${c.optIn ? '✅ Yes' : '<span class="muted">No</span>'}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No customers match.</td></tr>'}</tbody>
      </table></div>
      <div id="crmDetail"></div>`;
    if (C.open) await openCustomer(ctx, C.open, false);
  }

  async function openCustomer(ctx, phone, scroll = true) {
    C.open = phone;
    const c = await ctx.api(`/customers/${encodeURIComponent(phone)}`);
    const el = $('crmDetail');
    el.innerHTML = `<section class="card detail">
      <header><h3>${esc(c.name || c.phone)}</h3><button type="button" class="link" data-close-customer>Close</button></header>
      <div class="detail-grid">
        <div>
          <p class="small"><b>${esc(c.phone)}</b> · first order ${esc(dateFmt(c.firstOrderAt))} via ${esc(c.firstChannel || '—')}<br>${esc(c.address || 'No address yet')}</p>
          <div class="tiles mini">
            <div class="tile"><span class="t-label">Orders</span><span class="t-value">${c.orders}</span></div>
            <div class="tile"><span class="t-label">Spent</span><span class="t-value">${rupees(c.spent)}</span></div>
            <div class="tile"><span class="t-label">Points</span><span class="t-value">${num(c.points)}</span></div>
          </div>
          <p class="small"><b>Favourites:</b> ${c.favourites.map((f) => `${esc(f.name)} ×${f.qty}`).join(', ') || '—'}</p>
          <form data-points="${esc(c.phone)}" class="inline-form">
            <label class="small" for="ptsVal">Redeem or add points</label>
            <div class="row"><input id="ptsVal" name="points" type="number" step="1" placeholder="-50 to redeem, 20 to add" required>
            <input name="note" placeholder="Reason, e.g. free Coke" required><button class="btn" style="width:auto">Save</button></div>
          </form>
          <form data-profile="${esc(c.phone)}" class="inline-form">
            <label class="small"><input type="checkbox" name="optIn" ${c.optIn ? 'checked' : ''} style="width:auto"> Opted in to offers on WhatsApp</label>
            <label class="small" for="cTags">Tags (comma separated)</label><input id="cTags" name="tags" value="${esc(c.tags.join(', '))}" placeholder="e.g. office, bulk, jain">
            <label class="small" for="cNotes">Notes</label><textarea id="cNotes" name="notes" placeholder="Preferences, complaints, birthdays…">${esc(c.notes || '')}</textarea>
            <button class="btn secondary" style="margin-top:8px">Save profile</button>
          </form>
        </div>
        <div>
          <h4>Orders</h4>
          <div class="table-wrap"><table class="data"><tbody>${c.history.map((o) => `<tr><td><b>${esc(o.code)}</b><br><span class="small muted">${esc(dateFmt(o.at))} · ${esc(outletName(o.outletId))} · ${esc(o.channel)}</span><br><span class="small">${esc(o.items)}</span></td><td class="n">${rupees(o.total)}<br><span class="small muted">${esc(o.status)}</span></td></tr>`).join('')}</tbody></table></div>
          <h4>Points history</h4>
          <div class="table-wrap"><table class="data"><tbody>${c.ledger.map((l) => `<tr><td>${esc(l.note || l.kind)}<br><span class="small muted">${esc(dateFmt(l.at))} · ${esc(l.kind)}</span></td><td class="n">${l.points > 0 ? '+' : ''}${l.points}</td></tr>`).join('') || '<tr><td class="muted">No points yet.</td></tr>'}</tbody></table></div>
        </div>
      </div>
    </section>`;
    if (scroll) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---- Menu management ------------------------------------------------------

  const M = { scope: 'all', category: '', mode: 'percent', value: '', round: '1', selected: new Set(), preview: null, msg: '' };

  async function renderMenu(ctx) {
    if (document.activeElement?.closest?.('#view .menu-table input, #view .bulk input')) return;
    const { items, lastChange } = await ctx.api('/menu');
    const cats = [...new Set(items.map((i) => i.category))];
    if (!M.category) M.category = cats[0];
    $('view').innerHTML = `
      <section class="card bulk">
        <header><h3>Change prices in one click</h3>${lastChange ? `<button type="button" class="btn secondary" style="width:auto" id="mUndo">↶ Undo: ${esc(lastChange.note)}</button>` : ''}</header>
        <div class="row wrap">
          <select id="mScope" aria-label="Which dishes">
            <option value="all" ${M.scope === 'all' ? 'selected' : ''}>All dishes</option>
            <option value="category" ${M.scope === 'category' ? 'selected' : ''}>One category</option>
            <option value="items" ${M.scope === 'items' ? 'selected' : ''}>Ticked dishes (${M.selected.size})</option>
          </select>
          <select id="mCat" aria-label="Category" class="${M.scope === 'category' ? '' : 'hidden'}">${cats.map((c) => `<option ${c === M.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
          <select id="mMode" aria-label="Change by"><option value="percent" ${M.mode === 'percent' ? 'selected' : ''}>by %</option><option value="amount" ${M.mode === 'amount' ? 'selected' : ''}>by ₹</option></select>
          <input id="mValue" type="number" step="any" placeholder="e.g. 5 or -10" value="${esc(M.value)}" style="max-width:130px" aria-label="Amount">
          <select id="mRound" aria-label="Round to"><option value="1" ${M.round === '1' ? 'selected' : ''}>Round to ₹1</option><option value="5" ${M.round === '5' ? 'selected' : ''}>Round to ₹5</option><option value="10" ${M.round === '10' ? 'selected' : ''}>Round to ₹10</option></select>
          <button type="button" class="btn" style="width:auto" id="mPreview">Preview</button>
        </div>
        <div class="row wrap quick">${[['percent', 5], ['percent', 10], ['percent', -5], ['amount', 10], ['amount', -10]].map(([m, v]) => `<button type="button" class="chip" data-quick="${m}:${v}">${v > 0 ? '+' : '−'}${m === 'percent' ? `${Math.abs(v)}%` : `₹${Math.abs(v)}`}</button>`).join('')}</div>
        ${M.msg ? `<p class="small" role="status">${esc(M.msg)}</p>` : ''}
        ${M.preview ? `<div class="preview">
          <p><b>${esc(M.preview.label)}</b>: ${M.preview.changes.length} dish${M.preview.changes.length === 1 ? '' : 'es'} change.</p>
          <div class="table-wrap"><table class="data"><thead><tr><th>Dish</th><th class="n">Now</th><th class="n">New</th></tr></thead><tbody>
          ${M.preview.changes.map((c) => `<tr><td>${esc(c.name)}</td><td class="n">${rupees(c.oldPrice)}</td><td class="n"><b>${rupees(c.newPrice)}</b></td></tr>`).join('')}</tbody></table></div>
          <div class="row"><button type="button" class="btn" style="width:auto" id="mApply">Apply new prices</button><button type="button" class="btn secondary" style="width:auto" id="mCancel">Cancel</button></div>
        </div>` : ''}
      </section>
      <section class="card">
        <header><h3>Dishes</h3><span class="muted small">Edit and press Enter or click away to save. Stock per outlet is on the <button type="button" class="link" data-view="stock">Stock</button> tab.</span></header>
        <div class="table-wrap"><table class="data menu-table">
          <thead><tr><th><span class="sr-only">Select</span></th><th>Dish</th><th>Category</th><th>Veg</th><th class="n">Price ₹</th><th>On menu</th></tr></thead>
          <tbody>${items.map((i) => `<tr class="${i.active ? '' : 'off'}">
            <td><input type="checkbox" data-select="${i.id}" ${M.selected.has(i.id) ? 'checked' : ''} aria-label="Select ${esc(i.name)}" style="width:auto"></td>
            <td><input data-field="name" data-id="${i.id}" value="${esc(i.name)}" aria-label="Name"></td>
            <td><input data-field="category" data-id="${i.id}" value="${esc(i.category)}" aria-label="Category" list="catList"></td>
            <td><input type="checkbox" data-field="veg" data-id="${i.id}" ${i.veg ? 'checked' : ''} aria-label="Veg" style="width:auto"></td>
            <td class="n"><input type="number" min="1" step="1" data-field="price" data-id="${i.id}" value="${i.price / 100}" aria-label="Price" class="price"></td>
            <td><input type="checkbox" data-field="active" data-id="${i.id}" ${i.active ? 'checked' : ''} aria-label="On menu" style="width:auto"></td>
          </tr>`).join('')}</tbody>
        </table></div>
        <datalist id="catList">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
        <form id="mAdd" class="row wrap" style="margin-top:12px">
          <input name="name" placeholder="New dish name" required style="max-width:220px">
          <input name="category" placeholder="Category" list="catList" required style="max-width:160px">
          <input name="price" type="number" min="1" step="1" placeholder="Price ₹" required style="max-width:110px">
          <label class="small"><input type="checkbox" name="veg" checked style="width:auto"> Veg</label>
          <button class="btn" style="width:auto">Add dish</button>
        </form>
      </section>`;
  }

  // ---- Events -------------------------------------------------------------

  const ctx = () => window.RCAdmin;
  const rerender = () => window.RCAdmin.refresh();

  document.addEventListener('click', async (e) => {
    const t = e.target;
    const p = t.closest('[data-preset]');
    if (p) { A.preset = p.dataset.preset; if (A.preset === 'custom') { const r = range(); A.from = A.from || r.from; A.to = A.to || r.to; } return rerender(); }
    const csvBtn = t.closest('[data-csv]');
    if (csvBtn && A.data) {
      if (csvBtn.dataset.csv === 'ratings') {
        download(`dish-ratings-${A.data.range.from}-to-${A.data.range.to}.csv`, csv([['dish', 'average_stars', 'ratings', 'one_or_two_stars'],
          ...A.data.reviews.byItem.map((i) => [i.name, i.average, i.count, i.low])]));
        return;
      }
      if (csvBtn.dataset.csv === 'combos') {
        download(`combinations-${A.data.range.from}-to-${A.data.range.to}.csv`, csv([['dish_1', 'dish_2', 'orders', 'pct_of_orders', 'dish1_takers_also_take_dish2', 'revenue_rs'],
          ...A.data.combinations.map((c) => [c.items[0], c.items[1], c.orders, (c.share * 100).toFixed(1), (c.withA * 100).toFixed(0), (c.revenue / 100).toFixed(2)])]));
        return;
      }
      if (csvBtn.dataset.csv === 'items') {
        download(`item-sales-${A.data.range.from}-to-${A.data.range.to}.csv`, csv([['rank', 'dish', 'category', 'qty', 'revenue_rs', 'share', 'orders', 'in_pct_of_orders'],
          ...A.data.items.map((i) => [i.rank, i.name, i.category, i.qty, (i.revenue / 100).toFixed(2), (i.share * 100).toFixed(1), i.orders, (i.attachRate * 100).toFixed(1)])]));
      } else {
        download(`outlet-sales-${A.data.range.from}-to-${A.data.range.to}.csv`, csv([['outlet', 'orders', 'sales_rs', 'avg_order_rs', 'share', 'cancelled', 'deliveries', 'items_sold'],
          ...A.data.outlets.map((o) => [o.name, o.orders, (o.sales / 100).toFixed(2), (o.aov / 100).toFixed(2), (o.share * 100).toFixed(1), o.cancelled, o.delivery, o.itemsSold])]));
      }
      return;
    }
    const go = t.closest('[data-goto]');
    if (go) return window.RCAdmin.setView(go.dataset.goto);
    const seg = t.closest('[data-seg]');
    if (seg) { C.segment = seg.dataset.seg; return rerender(); }
    const row = t.closest('[data-customer]');
    if (row) return openCustomer(ctx(), row.dataset.customer);
    if (t.closest('[data-close-customer]')) { C.open = null; $('crmDetail').innerHTML = ''; return; }
    if (t.id === 'cExport') {
      const res = await fetch('/api/admin/customers.csv?' + customersQuery(ctx()), { headers: { Authorization: 'Bearer ' + ctx().state.token } });
      return download(`${BRAND.id}-customers.csv`, await res.text());
    }
    const quick = t.closest('[data-quick]');
    if (quick) { const [m, v] = quick.dataset.quick.split(':'); M.mode = m; M.value = v; return previewPrices(); }
    if (t.id === 'mPreview') { M.value = $('mValue').value; return previewPrices(); }
    if (t.id === 'mCancel') { M.preview = null; return rerender(); }
    if (t.id === 'mApply') {
      try {
        const r = await ctx().api('/menu/bulk-price', { method: 'POST', body: { ...bulkBody(), apply: true } });
        M.msg = `Done: ${r.label}. ${r.changes.length} prices updated. Undo is available above.`;
      } catch (err) { M.msg = err.message; }
      M.preview = null;
      return rerender();
    }
    if (t.id === 'mUndo') {
      try { const r = await ctx().api('/menu/undo', { method: 'POST' }); M.msg = `Undone: ${r.undone}.`; } catch (err) { M.msg = err.message; }
      return rerender();
    }
  });

  function bulkBody() {
    return { scope: M.scope, category: M.category, itemIds: [...M.selected], mode: M.mode, value: Number(M.value), round: Number(M.round) };
  }

  async function previewPrices() {
    try {
      M.preview = await ctx().api('/menu/bulk-price', { method: 'POST', body: bulkBody() });
      M.msg = M.preview.changes.length ? '' : 'Those prices would not change after rounding.';
      if (!M.preview.changes.length) M.preview = null;
    } catch (err) { M.preview = null; M.msg = err.message; }
    rerender();
  }

  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.id === 'aFrom' || t.id === 'aTo') { A.from = $('aFrom').value; A.to = $('aTo').value; if (A.from && A.to && A.from <= A.to) rerender(); return; }
    if (t.id === 'aChannel') { A.channel = t.value; return rerender(); }
    if (t.id === 'aFulfil') { A.fulfilment = t.value; return rerender(); }
    if (t.id === 'aItemSort') { A.itemSort = t.value; return rerender(); }
    if (t.id === 'cOptIn') { C.optIn = t.checked; return rerender(); }
    if (t.id === 'cSort') { C.sort = t.value; return rerender(); }
    if (t.id === 'mScope') { M.scope = t.value; M.preview = null; return rerender(); }
    if (t.id === 'mCat') { M.category = t.value; return; }
    if (t.id === 'mMode') { M.mode = t.value; return; }
    if (t.id === 'mRound') { M.round = t.value; return; }
    if (t.dataset.select) { const id = Number(t.dataset.select); if (t.checked) M.selected.add(id); else M.selected.delete(id); return; }
    if (t.dataset.field) {
      const f = t.dataset.field;
      const value = t.type === 'checkbox' ? t.checked : t.value;
      try {
        await ctx().api(`/menu/${t.dataset.id}`, { method: 'PATCH', body: { [f]: f === 'price' ? Number(value) : value } });
        t.classList.add('saved');
        setTimeout(() => t.classList.remove('saved'), 900);
        if (f === 'active' || f === 'price') { M.msg = f === 'price' ? 'Price saved. Undo is available above.' : ''; rerender(); }
      } catch (err) { M.msg = err.message; rerender(); }
    }
  });

  let searchTimer;
  document.addEventListener('input', (e) => {
    if (e.target.id !== 'cSearch') return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { C.q = e.target.value; rerender().then(() => { const s = $('cSearch'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }); }, 300);
  });

  document.addEventListener('submit', async (e) => {
    const f = e.target;
    if (f.id === 'mAdd') {
      e.preventDefault();
      try {
        await ctx().api('/menu', { method: 'POST', body: { name: f.name.value, category: f.category.value, price: Number(f.price.value), veg: f.veg.checked } });
        M.msg = `Added ${f.name.value}.`;
      } catch (err) { M.msg = err.message; }
      return rerender();
    }
    if (f.dataset.points) {
      e.preventDefault();
      try {
        const pts = Number(f.points.value);
        await ctx().api(`/customers/${encodeURIComponent(f.dataset.points)}/points`, { method: 'POST', body: { points: pts, note: f.note.value, kind: pts < 0 ? 'redeem' : 'adjust' } });
        await openCustomer(ctx(), f.dataset.points, false);
      } catch (err) { alert(err.message); }
      return;
    }
    if (f.dataset.profile) {
      e.preventDefault();
      await ctx().api(`/customers/${encodeURIComponent(f.dataset.profile)}`, { method: 'PATCH', body: { optIn: f.optIn.checked, tags: f.tags.value, notes: f.notes.value } });
      return rerender();
    }
  });

  const view = (fn) => () => { tip.hidden = true; return fn(ctx()); };
  window.RCInsights = { analytics: view(renderAnalytics), customers: view(renderCustomers), menu: view(renderMenu) };
})();
