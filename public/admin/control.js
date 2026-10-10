'use strict';

// Head office controls: Stock (every dish at every outlet: on/off and how many
// are left) and Outlets (accepting orders, outlet panel PINs, signed-in tablets).
// Loaded after staff/panel.js and insights.js; registers its views on RCInsights.

(() => {
  const $ = (id) => document.getElementById(id);
  const short = (name) => BRAND.short(String(name || ''));
  const when = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—');
  const LOW = 5;
  const S = { q: '', category: '', show: 'all', msg: '' };

  // ---- Stock ----------------------------------------------------------------

  function cell(item, outletId, c) {
    const label = `${item.name} at ${short(window.RCAdmin.state.outlets.find((o) => o.id === outletId)?.name)}`;
    const cls = !c.on ? 'off' : c.remaining === 0 ? 'out' : c.remaining != null && c.remaining <= LOW ? 'low' : '';
    return `<td class="stock-cell ${cls}">
      <label><input type="checkbox" data-stock-on="${outletId}" data-item="${item.id}" ${c.on ? 'checked' : ''} aria-label="${esc(label)} available" style="width:auto"> ${c.on ? 'On' : 'Off'}</label>
      <input type="number" min="0" step="1" inputmode="numeric" data-stock-count="${outletId}" data-item="${item.id}" value="${c.remaining ?? ''}" placeholder="no limit" aria-label="${esc(label)}: how many left">
    </td>`;
  }

  async function renderStock(ctx) {
    if (document.activeElement?.closest?.('#view .stock-table input, #view .stock-filters input')) return;
    const board = await ctx.api('/stock');
    const outlets = ctx.state.outletId ? board.outlets.filter((o) => String(o.id) === String(ctx.state.outletId)) : board.outlets;
    const cats = [...new Set(board.items.map((i) => i.category))];
    const cells = (i) => outlets.map((o) => i.outlets[o.id]);
    const counts = { off: 0, out: 0, low: 0 };
    for (const i of board.items) {
      for (const c of cells(i)) {
        if (!c.on) counts.off += 1;
        else if (c.remaining === 0) counts.out += 1;
        else if (c.remaining != null && c.remaining <= LOW) counts.low += 1;
      }
    }
    const q = S.q.trim().toLowerCase();
    const items = board.items.filter((i) => (!S.category || i.category === S.category) && (!q || i.name.toLowerCase().includes(q))
      && (S.show === 'all' || cells(i).some((c) => (S.show === 'off' ? !c.on || c.remaining === 0 : c.remaining != null))));
    $('view').innerHTML = `
      <div class="tiles">
        <div class="tile"><span class="t-label">Switched off</span><span class="t-value">${counts.off}</span><span class="t-foot muted">dish × outlet</span></div>
        <div class="tile"><span class="t-label">Sold out (count at 0)</span><span class="t-value">${counts.out}</span><span class="t-foot muted">dish × outlet</span></div>
        <div class="tile"><span class="t-label">Running low (${LOW} or fewer)</span><span class="t-value">${counts.low}</span><span class="t-foot muted">dish × outlet</span></div>
      </div>
      <section class="card">
        <header><h3>Stock ${ctx.state.outletId ? `at ${esc(short(outlets[0]?.name))}` : 'at every outlet'}</h3>
          <span class="muted small">Only head office can change stock. Tick to sell a dish at an outlet; enter how many are left to sell only that many (orders count it down, cancellations add back, 0 = sold out). Empty = no limit.</span></header>
        <div class="filters stock-filters">
          <input type="search" id="sQ" placeholder="Search dish" value="${esc(S.q)}" aria-label="Search dish">
          <select id="sCat" aria-label="Category"><option value="">All categories</option>${cats.map((c) => `<option ${c === S.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
          <div class="seg" role="group" aria-label="Show">${[['all', 'All dishes'], ['off', 'Off or sold out'], ['count', 'With a count']].map(([k, l]) => `<button type="button" data-stock-show="${k}" class="${S.show === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        </div>
        ${S.msg ? `<p class="small" role="status">${esc(S.msg)}</p>` : ''}
        <div class="table-wrap"><table class="data stock-table">
          <thead><tr><th>Dish</th>${outlets.map((o) => `<th>${esc(short(o.name))}${o.accepting ? '' : ' <span class="chip">paused</span>'}</th>`).join('')}${outlets.length > 1 ? '<th>All outlets</th>' : ''}</tr></thead>
          <tbody>${items.map((i) => `<tr>
            <td><b>${esc(i.name)}</b><br><span class="small muted">${esc(i.category)}</span></td>
            ${outlets.map((o) => cell(i, o.id, i.outlets[o.id])).join('')}
            ${outlets.length > 1 ? `<td class="stock-all"><button type="button" class="chip" data-stock-all="on" data-item="${i.id}">All on</button> <button type="button" class="chip" data-stock-all="off" data-item="${i.id}">All off</button> <button type="button" class="chip" data-stock-all="nolimit" data-item="${i.id}">No limits</button></td>` : ''}
          </tr>`).join('') || `<tr><td colspan="${outlets.length + 2}" class="muted">No dishes match.</td></tr>`}</tbody>
        </table></div>
      </section>`;
  }

  async function saveStock(body, done) {
    try {
      await window.RCAdmin.api('/stock', { method: 'POST', body });
      S.msg = done;
    } catch (err) { S.msg = err.message; }
    window.RCAdmin.refresh();
  }

  // ---- Outlets ----------------------------------------------------------------

  // Add-outlet form, also used to edit one (S.editing = outlet id).
  // Cities the business already has outlets in.
  let knownCities = [];
  const cities = () => knownCities;
  function outletForm(o) {
    const v = (k) => esc(o?.[k] ?? '');
    const f = (name, label, input, hint = '') => `<label class="ofield"><span>${label}</span>${input}${hint ? `<small class="muted">${hint}</small>` : ''}</label>`;
    return `<form id="outletForm" class="outlet-form" data-id="${o ? o.id : ''}">
      ${f('name', 'Outlet name', `<input name="name" required value="${o ? esc(short(o.name)) : ''}" placeholder="e.g. Sector 22">`, BRAND.outletPrefix ? `Shown to customers as "${esc(BRAND.outletPrefix)}…"` : '')}
      ${f('city', 'City', `<input name="city" required list="cityList" value="${v('city')}" placeholder="${esc(cities()[0] || 'City')}">`)}
      ${f('address', 'Full address', `<input name="address" required value="${v('address')}" placeholder="SCO / booth no., market, sector, PIN code">`)}
      ${f('phone', 'Outlet phone', `<input name="phone" required inputmode="tel" value="${v('phone')}" placeholder="98765 43210">`)}
      ${f('mapsLink', 'Location', `<input name="mapsLink" placeholder="Paste the Google Maps link of the outlet">`, `Or type the coordinates:${o ? ` now ${o.lat}, ${o.lng}` : ''}`)}
      <div class="row"><input name="lat" type="number" step="any" placeholder="Latitude" value="${v('lat')}" aria-label="Latitude"><input name="lng" type="number" step="any" placeholder="Longitude" value="${v('lng')}" aria-label="Longitude"></div>
      <div class="row">${f('opens', 'Opens', `<input name="opens" type="time" required value="${o ? v('opens') : '11:00'}">`)}${f('closes', 'Closes', `<input name="closes" type="time" required value="${o ? v('closes') : '23:00'}">`, 'Same time = open 24 hours')}</div>
      ${f('upiId', 'UPI ID for online payments', `<input name="upiId" value="${v('upi_id')}" placeholder="${esc(BRAND.upiExample)}">`, 'Optional. Without it, customers pay cash/UPI on delivery.')}
      ${f('sfxStoreCode', 'Shadowfax store code', `<input name="sfxStoreCode" value="${v('sfx_store_code')}">`, 'Optional, from Shadowfax onboarding.')}
      ${f('waPaymentConfig', 'WhatsApp payment configuration', `<input name="waPaymentConfig" value="${v('wa_payment_config')}">`, 'Optional, from WhatsApp Manager → Payments.')}
      ${o ? '' : f('pin', 'Outlet panel PIN', '<input name="pin" type="password" inputmode="numeric" pattern="\\d{4,8}" placeholder="4–8 digits">', 'Optional now; you can set it later.')}
      <datalist id="cityList">${cities().map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <p class="error hidden" role="alert"></p>
      <div class="row"><button class="btn" style="width:auto">${o ? 'Save changes' : 'Add outlet'}</button><button type="button" class="btn secondary" style="width:auto" data-outlet-form="close">Cancel</button></div>
    </form>`;
  }

  async function renderOutlets(ctx) {
    if (document.activeElement?.closest?.('#view .outlet-table input, #view .outlet-form')) return;
    const [outlets, logins] = await Promise.all([ctx.api('/outlets'), ctx.api('/logins')]);
    ctx.state.outlets = outlets;
    knownCities = [...new Set(outlets.map((o) => o.city))];
    // Keep the top bar's outlet filter in step with new outlets.
    const sel = $('outlet');
    if (sel && sel.options.length !== outlets.length + 1) {
      sel.innerHTML = '<option value="">All outlets</option>' + outlets.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('');
      sel.value = ctx.state.outletId;
    }
    const login = new Map(logins.map((l) => [l.outletId, l]));
    const editing = S.editing === 'new' ? null : outlets.find((o) => o.id === S.editing);
    $('view').innerHTML = `
      <section class="card">
        <header><h3>${S.editing ? (editing ? `Edit ${esc(short(editing.name))}` : 'Add a new outlet') : `${outlets.length} outlets`}</h3>
          ${S.editing ? '' : '<button type="button" class="btn" style="width:auto" data-outlet-form="new">+ Add outlet</button>'}</header>
        ${S.editing ? outletForm(editing) : '<p class="small muted">A new outlet takes orders straight away: customers nearest to it are routed there, the whole menu is in stock until you change it on the Stock tab, and its tablet can log in once it has a PIN.</p>'}
      </section>
      <section class="card">
        <header><h3>Outlets and outlet panel logins</h3>
          <span class="muted small">Each outlet's tablet opens <b>/outlet/</b> and logs in with the PIN you set here. It then sees only that outlet's orders, chats and (read-only) stock. Changing a PIN signs that outlet's tablets out.</span></header>
        ${S.msg ? `<p class="small" role="status">${esc(S.msg)}</p>` : ''}
        <div class="table-wrap"><table class="data outlet-table">
          <thead><tr><th>Outlet</th><th>Taking orders</th><th>Panel login</th><th>Tablets signed in</th><th>Set new PIN</th><th><span class="sr-only">Edit</span></th></tr></thead>
          <tbody>${outlets.map((o) => {
            const l = login.get(o.id) || {};
            return `<tr>
              <td><b>${esc(short(o.name))}</b><br><span class="small muted">${esc(o.address)} · ${esc(o.phone)} · ${o.opens === o.closes ? 'open 24 hours' : `${esc(o.opens)}–${esc(o.closes)}`}</span></td>
              <td><label><input type="checkbox" data-accept="${o.id}" ${o.accepting_orders ? 'checked' : ''} style="width:auto" aria-label="${esc(short(o.name))} taking orders"> ${o.accepting_orders ? 'Yes' : 'Paused'}</label></td>
              <td>${l.hasPin ? `PIN set ${esc(when(l.pinSetAt))}` : '<span class="chip">No PIN yet</span>'}</td>
              <td>${l.devices || 0}${l.lastLoginAt ? `<br><span class="small muted">last ${esc(when(l.lastLoginAt))}</span>` : ''}${l.devices ? `<br><button type="button" class="link" data-signout="${o.id}">Sign out all</button>` : ''}</td>
              <td><form class="row" data-pin="${o.id}"><input name="pin" type="password" inputmode="numeric" pattern="\\d{4,8}" placeholder="4–8 digits" required aria-label="New PIN for ${esc(short(o.name))}" style="max-width:120px"><button class="btn" style="width:auto">Save</button></form></td>
              <td><button type="button" class="link" data-outlet-form="${o.id}">Edit</button></td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>
      </section>`;
  }

  // ---- Events -------------------------------------------------------------------

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.stockOn) {
      saveStock({ outletId: Number(t.dataset.stockOn), itemId: Number(t.dataset.item), available: t.checked }, 'Saved.');
    } else if (t.dataset.stockCount) {
      saveStock({ outletId: Number(t.dataset.stockCount), itemId: Number(t.dataset.item), remaining: t.value === '' ? null : Number(t.value) }, 'Saved.');
    } else if (t.id === 'sCat') {
      S.category = t.value; window.RCAdmin.refresh();
    } else if (t.dataset.accept) {
      window.RCAdmin.api(`/outlets/${t.dataset.accept}`, { method: 'PATCH', body: { acceptingOrders: t.checked } })
        .then(() => { S.msg = ''; window.RCAdmin.refresh(); }, (err) => alert(err.message));
    }
  });

  document.addEventListener('input', (e) => {
    if (e.target.id !== 'sQ') return;
    S.q = e.target.value;
    clearTimeout(S.timer);
    S.timer = setTimeout(() => { e.target.blur(); window.RCAdmin.refresh().then(() => { const q = $('sQ'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }); }, 300);
  });

  document.addEventListener('keydown', (e) => {
    // Enter in a count saves it (via change) and moves on.
    if (e.key === 'Enter' && e.target.dataset?.stockCount) e.target.blur();
  });

  document.addEventListener('click', (e) => {
    const show = e.target.closest('[data-stock-show]');
    if (show) { S.show = show.dataset.stockShow; window.RCAdmin.refresh(); return; }
    const all = e.target.closest('[data-stock-all]');
    if (all) {
      const body = { outletId: 'all', itemId: Number(all.dataset.item) };
      if (all.dataset.stockAll === 'nolimit') body.remaining = null; else body.available = all.dataset.stockAll === 'on';
      saveStock(body, 'Saved for every outlet.');
      return;
    }
    const of = e.target.closest('[data-outlet-form]');
    if (of) {
      const v = of.dataset.outletForm;
      S.editing = v === 'close' ? null : v === 'new' ? 'new' : Number(v);
      document.activeElement?.blur();
      window.RCAdmin.refresh().then(() => { $('outletForm')?.elements.name.focus(); window.scrollTo({ top: 0 }); });
      return;
    }
    const so = e.target.closest('[data-signout]');
    if (so && confirm('Sign out every tablet of this outlet? They will need the PIN again.')) {
      window.RCAdmin.api(`/outlets/${so.dataset.signout}/sign-out`, { method: 'POST' })
        .then(() => { S.msg = 'Tablets signed out.'; window.RCAdmin.refresh(); }, (err) => alert(err.message));
    }
  });

  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('#outletForm');
    if (form) {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      const body = { name: data.name, city: data.city, address: data.address, phone: data.phone, opens: data.opens, closes: data.closes,
        upiId: data.upiId, sfxStoreCode: data.sfxStoreCode, waPaymentConfig: data.waPaymentConfig };
      if (data.mapsLink.trim()) body.mapsLink = data.mapsLink.trim(); else { body.lat = data.lat; body.lng = data.lng; }
      const id = form.dataset.id;
      try {
        const res = await window.RCAdmin.api(id ? `/outlets/${id}` : '/outlets', { method: id ? 'PATCH' : 'POST', body });
        const outlet = res.outlet || res;
        const near = res.nearest ? ` Nearest other outlet: ${short(res.nearest.name)}, ${res.nearest.km} km away${res.nearest.km < 0.5 ? ' (check the location is right)' : ''}.` : '';
        if (!id && data.pin) await window.RCAdmin.api(`/outlets/${outlet.id}/pin`, { method: 'POST', body: { pin: data.pin } });
        S.msg = id ? `Saved ${short(outlet.name)}.${near}` : `${short(outlet.name)} added and taking orders.${near}${data.pin ? ' PIN set.' : ' Set its PIN below so its tablet can log in.'}`;
        S.editing = null;
        document.activeElement?.blur();
      } catch (err) {
        // Keep what was typed; just show the problem.
        const p = form.querySelector('.error');
        p.textContent = err.message;
        p.classList.remove('hidden');
        return;
      }
      window.RCAdmin.refresh();
      return;
    }
    const f = e.target.closest('[data-pin]');
    if (!f) return;
    e.preventDefault();
    try {
      await window.RCAdmin.api(`/outlets/${f.dataset.pin}/pin`, { method: 'POST', body: { pin: f.elements.pin.value } });
      S.msg = 'PIN saved. Give it to the outlet manager; their tablets need to log in again.';
    } catch (err) { S.msg = err.message; }
    f.elements.pin.value = '';
    window.RCAdmin.refresh();
  });

  const reset = (fn) => (ctx) => { if (window.RCAdmin.state.lastView !== window.RCAdmin.state.view) { S.msg = ''; S.editing = null; } window.RCAdmin.state.lastView = window.RCAdmin.state.view; return fn(ctx); };
  Object.assign(window.RCInsights, {
    stock: () => reset(renderStock)(window.RCAdmin),
    outlets: () => reset(renderOutlets)(window.RCAdmin),
  });
})();
