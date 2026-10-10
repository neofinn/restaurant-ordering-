'use strict';

// Staff panels. One script, two panels:
//  - head office (/admin/, data-panel="admin"): every outlet, plus Customers,
//    Menu, Stock, Outlets and Analytics (insights.js, control.js).
//  - outlet (/outlet/, data-panel="outlet"): one outlet's live orders, chats,
//    history and a read-only stock list. Logs in with the outlet's PIN.

const PANEL = document.body.dataset.panel === 'outlet' ? 'outlet' : 'admin';

const $ = (id) => document.getElementById(id);
const rupees = (p) => '₹' + (p / 100).toLocaleString('en-IN', p % 100 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : {});
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KEY = PANEL === 'outlet' ? 'rco.' : 'rca.';
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(KEY + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

const NEXT_LABEL = {
  accepted: 'Accept', preparing: 'Start preparing', ready: 'Mark ready', out_for_delivery: 'Out for delivery',
  completed: 'Complete', cancelled: 'Cancel',
};

const state = { token: store.get('token', '') || (window.RC_DEMO && PANEL === 'admin' ? 'demo' : ''), outletId: store.get('outlet', ''), view: 'live', outlets: [], seen: new Set(), firstLoad: true, chatSeen: new Map(), chatsLoaded: false };

async function api(path, opts = {}) {
  const res = await fetch(`/api/${PANEL}` + path, {
    ...opts,
    headers: { ...(opts.headers || {}), 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { showLogin('Session expired or wrong token.'); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function showLogin(err) {
  clearInterval(poll);
  $('dash').classList.add('hidden');
  if (PANEL === 'outlet' && window.RC_DEMO) $('pinHint').innerHTML = 'Demo: every outlet\'s PIN is <b>1234</b>. Pick the outlet your order went to (shown on the order tracking page).';
  if (PANEL === 'outlet' && !$('loginOutlet').options.length) {
    try {
      const outlets = await (await fetch('/api/outlets')).json();
      $('loginOutlet').innerHTML = outlets.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('');
      $('loginOutlet').value = store.get('loginOutlet', outlets[0]?.id);
    } catch { /* offline: try again on the next login */ }
  }
  $('login').classList.remove('hidden');
  $('loginError').textContent = err || '';
  $('loginError').classList.toggle('hidden', !err);
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (PANEL === 'outlet') {
    // Swap the outlet's PIN for a session token.
    const res = await fetch('/api/outlet/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outletId: Number($('loginOutlet').value), pin: $('token').value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showLogin(data.error || 'Login failed');
    store.set('loginOutlet', $('loginOutlet').value);
    state.token = data.token;
  } else {
    state.token = $('token').value;
  }
  $('token').value = '';
  store.set('token', state.token);
  start();
});
$('logout').addEventListener('click', () => {
  if (PANEL === 'outlet' && state.token) api('/logout', { method: 'POST' }).catch(() => {});
  store.set('token', ''); state.token = ''; showLogin();
});

function beep() {
  if (!$('sound').checked) return;
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    o.frequency.value = 880;
    o.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.4);
  } catch { /* audio blocked */ }
}

const ago = (iso) => {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' });
};

// Partner comparison for the order card: "Porter ₹62 ✓ · Borzo ₹70 · Shadowfax: no cash on delivery".
function quotesLine(d) {
  if (!d.quotes || d.quotes.length < 2) return '';
  const parts = d.quotes.map((q) => (q.reason
    ? `${esc(q.label)}: ${esc(q.reason)}`
    : `${q.name === d.provider ? '<b>' : ''}${esc(q.label)} ${rupees(q.price)}${q.etaMin != null ? ` (~${Math.round(q.etaMin)} min)` : ''}${q.name === d.provider ? ' ✓</b>' : ''}`));
  return `<div class="small muted">Compared: ${parts.join(' · ')}</div>`;
}

function deliveryBlock(o) {
  if (o.fulfilment !== 'delivery' || ['awaiting_payment', 'unpaid'].includes(o.status) || (['completed', 'cancelled'].includes(o.status) && !o.delivery)) return '';
  const d = o.delivery;
  const book = `<button type="button" data-delivery="${o.code}" data-action="book">🛵 ${d ? 'Try again' : 'Book rider'}</button>`;
  const own = `<button type="button" class="cancel" data-delivery="${o.code}" data-action="own">Own rider</button>`;
  if (!d) {
    if (o.status === 'placed') return '<div class="small muted" style="margin-bottom:6px">🛵 When you accept, the best available delivery partner is booked.</div>';
    return `<div class="actions" style="margin-bottom:6px">${book}${own}</div>`;
  }
  if (d.status === 'OWN') return '<div class="small" style="margin-bottom:6px">🛵 Outlet rider</div>';
  const failed = ['FAILED', 'CANCELLED', 'CANCELLED_BY_CUSTOMER', 'RETURNED_TO_SELLER', 'UNDELIVERED'].includes(d.status);
  const rider = d.rider_name ? ` · <b>${esc(d.rider_name)}</b>${d.rider_phone ? ` <a href="tel:${esc(d.rider_phone)}">${esc(d.rider_phone)}</a>` : ''}` : '';
  const collect = !failed && d.collect && d.status !== 'DELIVERED' ? ` · rider collects ${rupees(d.collect)}` : '';
  const track = d.track_url ? ` · <a href="${esc(d.track_url)}" target="_blank" rel="noopener">track</a>` : '';
  const price = d.price ? ` · ${rupees(d.price)}` : '';
  return `<div class="small delivery ${failed ? 'bad' : ''}" style="margin-bottom:6px">🛵 ${esc(d.providerLabel || d.provider)}${price} · ${esc(d.label)}${rider}${collect}${track}
    ${quotesLine(d)}
    ${d.error ? `<div>${esc(d.error)}</div>` : ''}
    ${failed ? `<div class="actions" style="margin-top:6px">${book}${own}</div>` : ''}</div>`;
}

function payActions(o) {
  if (o.payment_status === 'claimed') {
    return `<div class="actions" style="margin-bottom:6px"><button type="button" class="paid" data-pay="${o.code}" data-to="paid">✅ Payment received</button><button type="button" class="cancel" data-pay="${o.code}" data-to="pending">Not received</button></div>`;
  }
  if (o.payment_status === 'pending') {
    return `<div class="actions" style="margin-bottom:6px"><button type="button" class="paid" data-pay="${o.code}" data-to="paid">✅ Payment received</button><button type="button" class="cancel" data-pay="${o.code}" data-to="cod">Take cash instead</button></div>`;
  }
  return '';
}

function orderCard(o) {
  const waiting = o.status === 'awaiting_payment';
  const hold = waiting ? `<div class="hold">${o.payment_status === 'claimed'
    ? `💳 Customer says they paid ${rupees(o.total)}. Check your UPI app; the order is confirmed when you tap <b>Payment received</b>.`
    : '⏳ Waiting for the customer to pay by UPI. <b>Don\'t cook yet.</b> Cancelled automatically if not paid in time.'}</div>` : '';
  const map = o.lat != null ? ` · <a href="https://www.google.com/maps/search/?api=1&query=${o.lat},${o.lng}" target="_blank" rel="noopener">map</a>` : '';
  return `<div class="order ${o.status}">
    <h4><span>${esc(o.code)}</span><span class="chip">${o.fulfilment === 'delivery' ? '🛵 Delivery' : '🏃 Pickup'} · ${o.channel === 'whatsapp' ? 'WhatsApp' : 'Web'}</span></h4>
    <div class="small muted">${ago(o.created_at)} · ${esc(o.statusLabel)}${state.outletId ? '' : ' · ' + esc(BRAND.short(o.outlet.name))}</div>
    ${hold}
    <ul>${o.items.map((i) => `<li>${i.qty} × ${esc(i.name)}${i.note ? ` <b style="color:var(--brand)">(${esc(i.note)})</b>` : ''}</li>`).join('')}</ul>
    ${o.notes ? `<div class="small"><b>Note:</b> ${esc(o.notes)}</div>` : ''}
    <div class="small"><b>${esc(o.customer_name)}</b> · <a href="tel:${esc(o.phone)}">${esc(o.phone)}</a></div>
    ${o.address ? `<div class="small">${esc(o.address)}${o.distance_km != null ? ` (${o.distance_km} km)` : ''}${map}</div>` : ''}
    <div style="margin:8px 0;display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b>${rupees(o.total)}</b>${o.fulfilment === 'delivery' ? ` <span class="small muted">incl. delivery ${rupees(o.delivery_fee)}</span>` : ''} <span class="chip pay-${o.payment_status}">${esc(o.paymentLabel)}</span></div>
    ${payActions(o)}
    ${deliveryBlock(o)}
    <div class="actions">${o.nextStatuses.map((s) => `<button type="button" class="${s === 'cancelled' ? 'cancel' : ''}" data-code="${o.code}" data-status="${s}">${NEXT_LABEL[s]}</button>`).join('')}</div>
  </div>`;
}

async function renderOrders() {
  const q = new URLSearchParams();
  if (state.outletId) q.set('outletId', state.outletId);
  if (state.view === 'history') q.set('status', 'all');
  const orders = await api('/orders?' + q);
  if (state.view === 'live') {
    // Beep for a new order to cook, and for a customer saying they paid (staff must check).
    // A UPI order that was waiting beeps when its payment is confirmed, not before.
    const key = (o) => `${o.code}:${o.status}:${o.payment_status}`;
    const fresh = orders.filter((o) => (o.status === 'placed' || o.payment_status === 'claimed') && !state.seen.has(key(o)));
    if (fresh.length && !state.firstLoad) beep();
    orders.forEach((o) => state.seen.add(key(o)));
    state.firstLoad = false;
  }
  const waiting = state.view === 'live' ? orders.filter((o) => o.status === 'awaiting_payment') : [];
  const rest = orders.filter((o) => !waiting.includes(o));
  $('view').innerHTML = (waiting.length ? `<h3 class="section">Waiting for payment (${waiting.length})</h3><div class="grid waiting">${waiting.map(orderCard).join('')}</div>` : '')
    + (waiting.length && rest.length ? '<h3 class="section">Orders</h3>' : '')
    + (rest.length ? `<div class="grid">${rest.map(orderCard).join('')}</div>` : (waiting.length ? '' : '<p class="muted">No orders here yet.</p>'));
}

function chatCard(h) {
  const outlet = state.outlets.find((o) => o.id === h.outlet_id);
  return `<div class="chat">
    <h4 style="margin:0;display:flex;justify-content:space-between;gap:8px"><span>💬 ${esc(h.name || 'Customer')} · <a href="tel:+${esc(h.phone)}">+${esc(h.phone)}</a></span>
      <span class="chip">${outlet ? esc(BRAND.short(outlet.name)) : 'No outlet yet'}</span></h4>
    <div class="small muted">Opened ${ago(h.created_at)}</div>
    <div class="bubbles">${h.messages.map((m) => `<div class="b ${m.direction}">${esc(m.body)}</div>`).join('')}</div>
    <form data-chat="${h.id}"><input name="text" placeholder="Reply on WhatsApp…" autocomplete="off" required><button class="btn">Send</button></form>
    <button type="button" class="btn secondary" data-close-chat="${h.id}">Close chat & hand back to bot</button>
  </div>`;
}

async function loadChats() {
  const chats = await api('/chats' + (state.outletId ? `?outletId=${state.outletId}` : ''));
  // Alert on new customer messages.
  let fresh = false;
  for (const h of chats) {
    const lastIn = h.messages.filter((m) => m.direction === 'in').length;
    if (state.chatsLoaded && lastIn > (state.chatSeen.get(h.id) ?? -1)) fresh = true;
    state.chatSeen.set(h.id, lastIn);
  }
  if (fresh) beep();
  state.chatsLoaded = true;
  $('chatCount').textContent = chats.length || '';
  return chats;
}

async function renderChats(chats) {
  // Don't wipe a reply someone is typing.
  if (document.activeElement?.closest?.('[data-chat]')) return;
  $('view').innerHTML = chats.length ? `<div class="grid">${chats.map(chatCard).join('')}</div>` : '<p class="muted">No open chats. Customers reach staff by typing "talk to us" on WhatsApp.</p>';
  $('view').querySelectorAll('.bubbles').forEach((b) => { b.scrollTop = b.scrollHeight; });
}

async function renderStats() {
  const rows = await api('/summary');
  const name = (id) => BRAND.short(state.outlets.find((o) => o.id === id)?.name);
  const shown = state.outletId ? rows.filter((r) => r.outlet_id === Number(state.outletId)) : rows;
  const total = shown.reduce((t, r) => ({ orders: t.orders + r.orders, revenue: t.revenue + r.revenue }), { orders: 0, revenue: 0 });
  $('stats').innerHTML = `<div class="stat">Today: <b>${total.orders}</b> order${total.orders === 1 ? '' : 's'} ·<b>${rupees(total.revenue)}</b></div>`
    + (state.outletId ? '' : shown.map((r) => `<div class="stat">${esc(name(r.outlet_id))}: ${r.orders} · ${rupees(r.revenue)}</div>`).join(''));
}

// Outlet panel: what head office has set, read only.
async function renderOutletStock() {
  const items = await api('/stock');
  const out = items.filter((i) => !i.available);
  const low = items.filter((i) => i.available && i.remaining != null);
  const row = (i) => `<tr><td>${esc(i.name)}<br><span class="small muted">${esc(i.category)}</span></td><td class="n">${
    i.remaining == null ? '<span class="chip">Off by head office</span>' : i.remaining === 0 ? '<span class="chip">Sold out (0 left)</span>' : `<b>${i.remaining}</b> left`}</td></tr>`;
  $('view').innerHTML = `<p class="small muted">Stock is managed by head office. Call them to switch a dish on or off or to change a count. Counts go down by themselves as orders come in.</p>
    <div class="two">
      <div class="card"><header><h3>Not available now (${out.length})</h3></header>
        <div class="table-wrap"><table class="data"><tbody>${out.map(row).join('') || '<tr><td class="muted">Everything is available.</td></tr>'}</tbody></table></div></div>
      <div class="card"><header><h3>Limited stock (${low.length})</h3></header>
        <div class="table-wrap"><table class="data"><tbody>${low.sort((a, b) => a.remaining - b.remaining).map(row).join('') || '<tr><td class="muted">No counts set.</td></tr>'}</tbody></table></div></div>
    </div>`;
}

async function refresh() {
  try {
    const chats = await loadChats();
    const insights = PANEL === 'admin' && window.RCInsights?.[state.view];
    const view = insights ? insights() : state.view === 'chats' ? renderChats(chats)
      : state.view === 'stock' ? renderOutletStock() : renderOrders();
    await Promise.all([view, renderStats()]);
  } catch (e) {
    if (e.message !== 'unauthorized') console.error(e);
  }
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-status]');
  if (b) {
    if (b.dataset.status === 'cancelled' && !confirm(`Cancel order ${b.dataset.code}?`)) return;
    b.disabled = true;
    try { await api(`/orders/${b.dataset.code}/status`, { method: 'POST', body: { status: b.dataset.status } }); } catch (err) { alert(err.message); }
    refresh();
  }
  const del = e.target.closest('[data-delivery]');
  if (del) {
    del.disabled = true;
    try { await api(`/orders/${del.dataset.delivery}/delivery`, { method: 'POST', body: { action: del.dataset.action } }); } catch (err) { alert(err.message); }
    refresh();
  }
  const pay = e.target.closest('[data-pay]');
  if (pay) {
    pay.disabled = true;
    try { await api(`/orders/${pay.dataset.pay}/payment`, { method: 'POST', body: { status: pay.dataset.to } }); } catch (err) { alert(err.message); }
    refresh();
  }
  const c = e.target.closest('[data-close-chat]');
  if (c) {
    try { await api(`/chats/${c.dataset.closeChat}/close`, { method: 'POST' }); } catch (err) { alert(err.message); }
    refresh();
  }
  const v = e.target.closest('[data-view]');
  if (v) setView(v.dataset.view);
});

function setView(view) {
  state.view = view;
  document.querySelector('.viz-tip')?.setAttribute('hidden', '');
  document.querySelectorAll('[data-view]').forEach((x) => x.classList.toggle('on', x.dataset.view === view));
  return refresh();
}

// Shared with insights.js (Customers, Menu, Analytics).
window.RCAdmin = { api, state, refresh, setView };

document.addEventListener('submit', async (e) => {
  const f = e.target.closest('[data-chat]');
  if (!f) return;
  e.preventDefault();
  const input = f.elements.text;
  try {
    await api(`/chats/${f.dataset.chat}/reply`, { method: 'POST', body: { text: input.value } });
    input.value = '';
    input.blur();
  } catch (err) { alert(err.message); }
  refresh();
});

$('outlet')?.addEventListener('change', (e) => {
  state.outletId = e.target.value;
  store.set('outlet', state.outletId);
  syncAccepting();
  refresh();
});

function syncAccepting() {
  const o = state.outlets.find((x) => String(x.id) === String(state.outletId));
  $('accepting').parentElement.classList.toggle('hidden', !o);
  if (o) $('accepting').checked = !!o.accepting_orders;
}

$('accepting').addEventListener('change', async (e) => {
  try {
    const o = await api(PANEL === 'outlet' ? '/me' : `/outlets/${state.outletId}`, { method: 'PATCH', body: { acceptingOrders: e.target.checked } });
    state.outlets = state.outlets.map((x) => (x.id === o.id ? o : x));
  } catch (err) { alert(err.message); e.target.checked = !e.target.checked; }
});

let poll;
async function start() {
  // Demo: the outlet tablet signs itself in to the outlet the demo picked.
  if (!state.token && PANEL === 'outlet' && window.RC_DEMO_LOGIN) {
    const res = await fetch('/api/outlet/login', { method: 'POST', body: JSON.stringify(window.RC_DEMO_LOGIN) });
    state.token = (await res.json()).token || '';
  }
  if (!state.token) return showLogin();
  try {
    if (PANEL === 'outlet') {
      // An outlet tablet is locked to its own outlet.
      const me = await api('/me');
      state.outlets = [me];
      state.outletId = String(me.id);
      $('outletName').textContent = BRAND.short(me.name);
    } else {
      state.outlets = await api('/outlets');
    }
  } catch { return; }
  $('login').classList.add('hidden');
  $('dash').classList.remove('hidden');
  if (PANEL === 'admin') {
    $('outlet').innerHTML = '<option value="">All outlets</option>' + state.outlets.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('');
    $('outlet').value = state.outletId;
  }
  syncAccepting();
  refresh();
  clearInterval(poll);
  // Live views refresh themselves; back-office views refresh when you act.
  poll = setInterval(() => { if (['live', 'chats', 'history'].includes(state.view) || (PANEL === 'outlet' && state.view === 'stock')) refresh(); else loadChats().catch(() => {}); }, 5000);
}

start();
