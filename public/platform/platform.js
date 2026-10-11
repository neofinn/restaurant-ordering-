'use strict';

// Platform admin: restaurants (onboarding, commission, Route account, head
// office logins), the ledger, weekly payouts and the platform's Connections.

(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rs = (p) => `${p < 0 ? '−' : ''}₹${(Math.abs(p || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const money = (p) => `<td class="n ${p < 0 ? 'neg' : ''}">${rs(p)}</td>`;
  const when = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');
  const ls = { get: (k) => { try { return localStorage.getItem(`plat.${k}`) || ''; } catch { return ''; } }, set: (k, v) => { try { localStorage.setItem(`plat.${k}`, v); } catch { /* private mode */ } } };
  const S = { token: ls.get('token'), view: 'overview', unlock: '', week: '', restaurant: '' };

  async function api(path, opts = {}) {
    const res = await fetch(`/platform/api${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${S.token}`, 'X-Owner-Unlock': S.unlock, ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401) { showLogin('Wrong or expired token.'); throw new Error('unauthorized'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.locked = data.locked; throw e; }
    return data;
  }
  // CSV downloads need the token too.
  async function download(path) {
    const res = await fetch(`/platform/api${path}`, { headers: { Authorization: `Bearer ${S.token}` } });
    if (!res.ok) return say((await res.json().catch(() => ({}))).error || 'Download failed', true);
    const name = (res.headers.get('content-disposition') || '').match(/filename="?([^";]+)/)?.[1] || 'export.csv';
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await res.blob()), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function say(text, bad) {
    $('msg').textContent = text || '';
    $('msg').className = `banner ${text ? (bad ? 'warn' : 'ok') : 'hidden'}`;
    if (text) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function showLogin(err) {
    $('dash').classList.add('hidden');
    $('logout').classList.add('hidden');
    $('login').classList.remove('hidden');
    $('loginError').textContent = err || '';
    $('loginError').classList.toggle('hidden', !err);
  }
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    S.token = $('token').value.trim();
    try { await api('/overview'); ls.set('token', S.token); start(); } catch (err) { if (err.message !== 'unauthorized') showLogin(err.message); }
  });
  $('logout').addEventListener('click', () => { S.token = ''; ls.set('token', ''); showLogin(); });
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (!b) return;
    S.view = b.dataset.view;
    say('');
    render();
  });

  function start() {
    $('login').classList.add('hidden');
    $('dash').classList.remove('hidden');
    $('logout').classList.remove('hidden');
    render();
  }

  async function render() {
    for (const b of $('tabs').querySelectorAll('[data-view]')) b.classList.toggle('on', b.dataset.view === S.view);
    $('view').innerHTML = '<p class="muted">Loading…</p>';
    try { await VIEWS[S.view](); } catch (e) { if (e.message !== 'unauthorized') $('view').innerHTML = `<p class="error">${esc(e.message)}</p>`; }
  }

  // ---- This week -----------------------------------------------------------
  async function overview() {
    const [o, list] = await Promise.all([api('/overview'), api('/restaurants')]);
    const w = o.week;
    $('view').innerHTML = `
      <p class="muted small">Week ${esc(w.weekStart)} to ${esc(w.weekEnd)} (delivered orders). Payments: ${o.gateway ? esc(o.gateway) : '<b>no gateway connected</b>'} · Route: ${o.route ? 'on' : 'off'}.</p>
      <div class="stats">
        <div class="stat"><b>${w.orders}</b>orders</div>
        <div class="stat"><b>${rs(w.sales)}</b>customers paid</div>
        <div class="stat"><b>${rs(w.commission)}</b>commission</div>
        <div class="stat"><b>${rs(w.commission_gst)}</b>GST on commission</div>
        <div class="stat"><b>${rs(w.delivery_fees)}</b>delivery fees (our riders)</div>
        <div class="stat"><b>${rs(w.gst_kept)}</b>food GST to deposit (9(5))</div>
        <div class="stat"><b>${rs(w.tds)}</b>TDS 194-O to deposit</div>
        <div class="stat"><b>${rs(w.payout)}</b>due to restaurants</div>
      </div>
      <div class="scroll"><table><thead><tr><th>Restaurant</th><th class="n">Orders</th><th class="n">Sales</th><th class="n">Commission</th><th class="n">Unsettled payout</th><th>Payout via</th></tr></thead><tbody>
      ${list.map((r) => `<tr><td><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a> ${r.status === 'paused' ? '<span class="pill warn">paused</span>' : ''}</td>
        <td class="n">${r.week.orders}</td>${money(r.week.sales)}${money(r.week.commission)}${money(r.unsettled)}
        <td>${r.route_account ? `Route <span class="pill ${r.route_status === 'activated' ? 'ok' : 'warn'}">${esc(r.route_status || 'not checked')}</span>` : 'bank transfer'}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No restaurants yet. Add one.</td></tr>'}
      </tbody></table></div>
      <p class="muted small">Rates: GST on commission ${o.terms.commissionGstPct}% · TDS ${o.terms.tdsPct}% · PG fee charged to restaurants ${o.terms.pgFeePct}% · food GST ${o.terms.platformPaysFoodGst ? 'paid by the platform (section 9(5))' : 'passed to restaurants'}. Set in the server's .env.</p>`;
  }

  // ---- Restaurants -----------------------------------------------------------
  const FIELDS = [
    ['name', 'Name shown to customers'], ['commission_pct', 'Commission % of food value'], ['status', 'Status', ['active', 'paused']],
    ['legal_name', 'Legal name (on invoices and bank)'], ['gstin', 'GSTIN'], ['pan', 'PAN'], ['fssai', 'FSSAI licence'],
    ['contact_name', 'Contact person'], ['contact_phone', 'Contact phone'], ['email', 'Email'],
    ['route_account', 'Razorpay Route linked account (acc_…)'], ['bank_name', 'Bank'], ['bank_account', 'Bank account number'], ['bank_ifsc', 'IFSC'],
    ['custom_domain', 'Own domain (optional)'], ['wa_phone_number_id', 'WhatsApp phone number ID (optional)'],
  ];
  const input = (k, v, opts) => (opts
    ? `<select name="${k}">${opts.map((o) => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select>`
    : `<input name="${k}" value="${esc(v ?? '')}" spellcheck="false">`);
  const formValues = (form) => Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, String(v).trim()]));

  async function restaurants() {
    const list = await api('/restaurants');
    $('view').innerHTML = list.map((r) => `
      <div class="card">
        <h3>${esc(r.brand.emoji || '')} ${esc(r.name)} <span class="pill ${r.status === 'active' ? 'ok' : 'warn'}">${esc(r.status)}</span></h3>
        <p class="small muted"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a> · <a href="${esc(r.headOffice)}" target="_blank" rel="noopener">head office</a> · commission ${r.commission_pct}% · added ${esc(when(r.created_at))}</p>
        <form data-edit="${esc(r.slug)}"><div class="grid">${FIELDS.map(([k, l, o]) => `<label>${esc(l)}${input(k, r[k], o)}</label>`).join('')}
          <label>Brand colour<input name="color" type="color" value="${esc(r.brand.colors?.brand || '#d62828')}"></label></div>
          <div class="row"><button class="btn">Save</button>
          <button class="btn secondary" type="button" data-route="${esc(r.slug)}">Check Route account</button>
          <button class="btn secondary" type="button" data-token="${esc(r.slug)}">New head office token</button>
          <button class="btn secondary" type="button" data-adjust="${esc(r.slug)}">Add adjustment</button></div>
        </form>
      </div>`).join('') || '<p class="muted">No restaurants yet.</p>';
  }

  // ---- Add restaurant ----------------------------------------------------------
  function add() {
    $('view').innerHTML = `
      <form class="card" id="addForm">
        <h3>New restaurant</h3>
        <div class="grid">
          <label>Web address name<input name="slug" placeholder="spice-route" required pattern="[a-z0-9-]{1,30}"></label>
          <label>Name shown to customers<input name="name" required></label>
          <label>Commission % of food value<input name="commission_pct" type="number" step="0.5" min="0" max="50" value="18"></label>
          <label>Emoji<input name="emoji" value="🍽️"></label>
          <label>Brand colour<input name="color" type="color" value="#d62828"></label>
          <label>One line about it<input name="description" placeholder="North Indian, tandoor and curries"></label>
        </div>
        <h3 style="margin-top:14px">First outlet</h3>
        <div class="grid">
          <label>Area / outlet name<input name="o.area" placeholder="Sector 17" required></label>
          <label>Address<input name="o.address" required></label>
          <label>City<input name="o.city" required></label>
          <label>Latitude<input name="o.lat" placeholder="30.7410" required></label>
          <label>Longitude<input name="o.lng" placeholder="76.7790" required></label>
          <label>Outlet phone<input name="o.phone" required></label>
          <label>Opens<input name="o.opens" value="11:00"></label>
          <label>Closes<input name="o.closes" value="23:00"></label>
        </div>
        <h3 style="margin-top:14px">Business and payout</h3>
        <div class="grid">${FIELDS.slice(3).map(([k, l]) => `<label>${esc(l)}${input(k, '')}</label>`).join('')}</div>
        <label>Menu (optional): paste CSV lines <span class="muted">Category, Name, Price in ₹, Veg (yes/no), Description</span>
          <textarea name="menuCsv" class="csv" placeholder="Starters,Paneer Tikka,249,yes,Smoky cottage cheese&#10;Mains,Butter Chicken,349,no,"></textarea></label>
        <p class="muted small">The restaurant can add and change dishes later in its head office (Menu). More outlets: head office → Outlets.</p>
        <div class="row"><button class="btn">Create restaurant</button></div>
      </form>`;
  }

  function addBody(v) {
    const outlet = {};
    const body = { brand: { emoji: v.emoji, description: v.description, colors: { brand: v.color } }, outlet };
    for (const [k, val] of Object.entries(v)) {
      if (k.startsWith('o.')) outlet[k.slice(2)] = val;
      else if (!['emoji', 'description', 'color'].includes(k)) body[k] = val;
    }
    return body;
  }

  $('view').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      if (f.id === 'addForm') {
        const r = await api('/restaurants', { method: 'POST', body: addBody(formValues(f)) });
        S.view = 'restaurants';
        await render();
        showToken(r.restaurant.name, r.restaurant.headOffice, r.adminToken);
      } else if (f.dataset.edit) {
        const v = formValues(f);
        const color = v.color;
        delete v.color;
        await api(`/restaurants/${f.dataset.edit}`, { method: 'PATCH', body: { ...v, brand: { colors: { brand: color } } } });
        await render();
        say('Saved.');
      } else if (f.dataset.paid) {
        await api(`/settlements/${f.dataset.paid}/paid`, { method: 'POST', body: { reference: formValues(f).reference } });
        await render();
        say('Marked paid.');
      } else if (f.dataset.conn) {
        const values = Object.fromEntries([...new FormData(f)].filter(([, val]) => val !== '').map(([k, val]) => [k.slice(2), val]));
        await api(`/connections/${f.dataset.conn}`, { method: 'PUT', body: { values } });
        await render();
        say('Saved. It applies to every restaurant straight away.');
      } else if (f.id === 'unlockForm') {
        const r = await api('/owner/unlock', { method: 'POST', body: { pin: formValues(f).pin } });
        S.unlock = r.token;
        await render();
      }
    } catch (err) { if (err.message !== 'unauthorized') say(err.message, true); }
  });

  function showToken(name, url, token) {
    say('');
    $('view').insertAdjacentHTML('afterbegin', `<div class="card"><h3>Head office login for ${esc(name)}</h3>
      <p class="small">Give this to the restaurant owner. It is shown only now; make a new one any time from Restaurants.</p>
      <p><a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a></p><p class="token">${esc(token)}</p></div>`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  $('view').addEventListener('click', async (e) => {
    const b = e.target.closest('button[type=button], button[data-act]');
    if (!b) return;
    try {
      if (b.dataset.route) {
        const r = await api(`/restaurants/${b.dataset.route}/route-check`, { method: 'POST' });
        say(r.message, !r.ok);
      } else if (b.dataset.token) {
        if (!confirm('Make a new head office token? The current one stops working.')) return;
        const r = await api(`/restaurants/${b.dataset.token}/token`, { method: 'POST' });
        showToken(b.dataset.token, r.headOffice, r.adminToken);
      } else if (b.dataset.adjust) {
        const amount = prompt('Adjustment in ₹ (negative = deduct from the restaurant, positive = pay extra):');
        if (!amount) return;
        const note = prompt('What is it for? (shown on the statement)');
        if (!note) return;
        await api(`/restaurants/${b.dataset.adjust}/adjustments`, { method: 'POST', body: { amount: Number(amount), note } });
        say('Adjustment added to next week\'s statement.');
      } else if (b.dataset.close) {
        if (!confirm(`Close the week of ${b.dataset.close}? Every restaurant gets its statement.`)) return;
        const r = await api('/settlements/close', { method: 'POST', body: { week: b.dataset.close } });
        S.week = r.week;
        await render();
        say(`${r.made.length} statements made for the week of ${r.week}.`);
      } else if (b.dataset.release) {
        if (!confirm('Release the Route transfers to this restaurant\'s bank?')) return;
        await api(`/settlements/${b.dataset.release}/release`, { method: 'POST' });
        await render();
        say('Released. Razorpay settles it to the restaurant on its next cycle.');
      } else if (b.dataset.csv) {
        await download(b.dataset.csv);
      } else if (b.dataset.week) {
        S.week = b.dataset.week;
        await render();
      } else if (b.dataset.retry) {
        await api(`/ledger/${b.dataset.retry}/retry-transfer`, { method: 'POST' });
        await render();
      } else if (b.dataset.test) {
        const r = await api(`/connections/${b.dataset.test}/test`, { method: 'POST' });
        say(r.message, r.ok === false);
      } else if (b.dataset.lock !== undefined) {
        await api('/owner/lock', { method: 'POST' });
        S.unlock = '';
        await render();
      }
    } catch (err) { if (err.message !== 'unauthorized') say(err.message, true); }
  });

  // ---- Ledger ------------------------------------------------------------------
  async function ledger() {
    const list = await api('/restaurants');
    const rows = await api(`/ledger${S.restaurant ? `?restaurant=${encodeURIComponent(S.restaurant)}` : ''}`);
    $('view').innerHTML = `
      <div class="row" style="margin-bottom:10px"><select id="ledgerFor" style="width:auto"><option value="">All restaurants</option>
        ${list.map((r) => `<option value="${esc(r.slug)}" ${r.slug === S.restaurant ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>
        <span class="muted small">Delivered orders and adjustments not yet in a weekly statement.</span></div>
      <div class="scroll"><table><thead><tr><th>When</th>${S.restaurant ? '' : '<th>Restaurant</th>'}<th>Order</th><th>Paid</th><th class="n">Customer paid</th><th class="n">Commission</th><th class="n">GST on comm.</th><th class="n">TDS</th><th class="n">Payout</th><th>Route</th></tr></thead><tbody>
      ${rows.map((x) => `<tr><td>${esc(when(x.at))}</td>${S.restaurant ? '' : `<td>${esc(x.slug)}</td>`}<td>${esc(x.order_code || x.note || '')}</td>
        <td>${esc(x.kind === 'order' ? `${x.payment} → ${x.collected_by}` : 'adjustment')}</td>${money(x.total)}${money(x.commission)}${money(x.commission_gst)}${money(x.tds)}${money(x.payout)}
        <td>${x.transfer_status && x.transfer_status !== 'none' ? `<span class="pill ${x.transfer_status === 'failed' ? 'warn' : 'ok'}">${esc(x.transfer_status)}</span>` : ''}
          ${x.transfer_status === 'failed' ? `<button type="button" class="link" data-retry="${x.id}" title="${esc(x.transfer_error || '')}">retry</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="10" class="muted">Nothing open.</td></tr>'}
      </tbody></table></div>`;
    $('ledgerFor').addEventListener('change', (e) => { S.restaurant = e.target.value; render(); });
  }

  // ---- Weekly payouts ------------------------------------------------------------
  const STATUS = { ready: 'warn', released: 'warn', paid: 'ok', carried: 'off', nothing: 'off' };
  async function settlements() {
    const { weeks, lastWeek } = await api('/settlements');
    const week = S.week || weeks[0]?.week_start || lastWeek;
    const list = await api(`/settlements/week/${week}`);
    const closed = weeks.some((w) => w.week_start === lastWeek);
    $('view').innerHTML = `
      <div class="card">
        <p class="small">Every Monday close last week: each restaurant gets a statement of its delivered orders, commission, TDS and adjustments.
        Route transfers held during the week are released (minus anything the restaurant owes); the rest is paid by bank transfer from the bank file.</p>
        <div class="row">${closed ? `<span class="muted small">Week of ${esc(lastWeek)} is closed.</span>` : `<button class="btn" type="button" data-close="${esc(lastWeek)}">Close week of ${esc(lastWeek)}</button>`}
        ${weeks.map((w) => `<button type="button" class="btn secondary" data-week="${esc(w.week_start)}" ${w.week_start === week ? 'style="outline:2px solid var(--brand)"' : ''}>${esc(w.week_start)}</button>`).join('')}</div>
      </div>
      <div class="row" style="margin-bottom:8px"><b>Week ${esc(week)}</b> <button type="button" class="btn secondary" data-csv="/settlements/week/${esc(week)}/bank.csv">Bank payout file (CSV)</button></div>
      <div class="scroll"><table><thead><tr><th>Restaurant</th><th class="n">Orders</th><th class="n">Food value</th><th class="n">Commission + GST</th><th class="n">TDS</th><th class="n">Cash kept</th><th class="n">Adjust.</th><th class="n">Net</th><th class="n">Route</th><th class="n">Bank</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map((s) => `<tr><td>${esc(s.name)}</td><td class="n">${s.orders}</td>${money(s.food)}${money(s.commission + s.commission_gst)}${money(s.tds)}${money(s.cash_collected)}${money(s.adjustments)}${money(s.net)}${money(s.via_route)}${money(s.manual)}
        <td><span class="pill ${STATUS[s.status] || ''}">${esc(s.status)}</span>${s.reference ? `<br><small>${esc(s.reference)}</small>` : ''}${s.error ? `<br><small class="neg">${esc(s.error)}</small>` : ''}</td>
        <td>${s.status === 'ready' && (s.via_route > 0 || s.net < 0) ? `<button type="button" class="btn" style="width:auto;padding:6px 10px" data-release="${s.id}">Release</button>` : ''}
          ${(s.status === 'released' || (s.status === 'ready' && s.via_route === 0 && s.manual > 0)) ? `<form data-paid="${s.id}" class="row" style="margin:0"><input name="reference" placeholder="UTR" style="width:110px"><button class="btn secondary" style="width:auto;padding:6px 10px">Paid</button></form>` : ''}
          <button type="button" class="link" data-csv="/settlements/${s.id}/statement.csv">statement</button></td></tr>`).join('') || '<tr><td colspan="12" class="muted">No statements for this week.</td></tr>'}
      </tbody></table></div>`;
  }

  // ---- Connections (platform keys) -------------------------------------------------
  async function connections() {
    let d;
    try { d = await api('/connections'); } catch (e) {
      if (!e.locked) throw e;
      $('view').innerHTML = `<form class="card" id="unlockForm" style="max-width:420px"><h3>Owner PIN</h3>
        <p class="small muted">Payment gateway, rider and WhatsApp keys for every restaurant. Set the PIN on the server: <code>npm run owner-pin -- --platform</code>.</p>
        <input name="pin" type="password" inputmode="numeric" autocomplete="off" required><div class="row"><button class="btn">Unlock</button></div></form>`;
      return;
    }
    const STATE = { on: 'ok', test: 'warn', warn: 'warn', off: 'off' };
    $('view').innerHTML = `<div class="row" style="margin-bottom:8px"><span class="muted small">Keys are encrypted (${esc(d.encryption)}). They apply to every restaurant at once.</span>
      <button type="button" class="btn secondary" data-lock>Lock now</button></div>
      ${d.integrations.map((c) => `<form class="card" data-conn="${esc(c.id)}"><h3>${esc(c.title)} <span class="pill ${STATE[c.status.state]}">${esc(c.status.text)}</span></h3>
        <p class="small muted">${esc(c.about)}${c.webhook ? ` Webhook: <code>${esc(c.webhook)}</code>` : ''}</p>
        <div class="grid">${c.fields.map((f) => `<label>${esc(f.label)}${f.type === 'select'
          ? `<select name="f:${esc(f.path)}">${f.options.map(([v, l]) => `<option value="${esc(v)}" ${v === f.value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`
          : `<input name="f:${esc(f.path)}" ${f.type === 'secret' ? `type="password" autocomplete="new-password" placeholder="${esc(f.hint || 'not set')}"` : `value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}"`} spellcheck="false">`}</label>`).join('')}</div>
        <div class="row"><button class="btn">Save</button>${c.testable ? `<button type="button" class="btn secondary" data-test="${esc(c.id)}">Test</button>` : ''}</div></form>`).join('')}`;
  }

  const VIEWS = { overview, restaurants, add, ledger, settlements, connections };
  if (S.token) api('/overview').then(start).catch((e) => { if (e.message !== 'unauthorized') showLogin(e.message); });
  else showLogin();
})();
