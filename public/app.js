'use strict';

// Customer ordering app. State lives in memory and is mirrored to
// localStorage so a refresh keeps the cart and location.

const $ = (id) => document.getElementById(id);
const rupees = (p) => '₹' + (p / 100).toLocaleString('en-IN', p % 100 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : {});
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = {
  get(k, d) { try { const v = localStorage.getItem('rc.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('rc.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const state = {
  // { fulfilment, lat, lng, label, outlet, distanceKm, etaMinutes }
  location: store.get('location', null),
  cart: store.get('cart', {}), // itemId -> qty
  menu: [],
  vegOnly: store.get('vegOnly', false),
  modeTab: 'delivery',
};

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { code: data.code });
  return data;
}

// ---- Location ---------------------------------------------------------

function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(b.dataset.close)));
document.querySelectorAll('.overlay').forEach((o) => o.addEventListener('click', (e) => { if (e.target === o) o.classList.add('hidden'); }));

function setModeTab(mode) {
  state.modeTab = mode;
  document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('deliveryPane').classList.toggle('hidden', mode !== 'delivery');
  $('pickupPane').classList.toggle('hidden', mode !== 'pickup');
  if (mode === 'pickup') renderOutletList();
}
document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setModeTab(b.dataset.mode)));

function showLocError(msg) {
  $('locError').textContent = msg;
  $('locError').classList.toggle('hidden', !msg);
}

async function locate(lat, lng, label, address = $('startAddress').value.trim()) {
  showLocError('');
  state.lastCoords = { lat, lng };
  const r = await api('/locate', { method: 'POST', body: { lat, lng, fulfilment: 'delivery' } });
  if (r.outlet) {
    setLocation({ fulfilment: 'delivery', lat, lng, label, address, outlet: r.outlet, distanceKm: r.distanceKm, etaMinutes: r.etaMinutes, deliveryCharge: r.deliveryCharge });
    closeModal('locModal');
    return;
  }
  const why = r.reason === 'closed' ? 'Outlets delivering to this area are closed right now.' : "Sorry, we don't deliver to this area yet.";
  const alt = r.pickupSuggestion;
  showLocError(alt ? `${why} You can pick up from ${alt.outlet.name} (${alt.distanceKm} km).` : `${why} All outlets are closed right now.`);
  if (alt) {
    setModeTab('pickup');
  }
}

$('useGps').addEventListener('click', () => {
  if (!navigator.geolocation) return showLocError('Location is not supported on this device. Please choose your area.');
  const btn = $('useGps');
  btn.disabled = true;
  btn.textContent = 'Finding you…';
  navigator.geolocation.getCurrentPosition(
    (pos) => locate(pos.coords.latitude, pos.coords.longitude, 'Current location')
      .catch((e) => showLocError(e.message))
      .finally(() => { btn.disabled = false; btn.textContent = '📍 Use my current location'; }),
    () => {
      btn.disabled = false;
      btn.textContent = '📍 Use my current location';
      showLocError('Could not get your location. Please allow location access or choose your area.');
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
  );
});

// Typed address: place it from known areas; ask which city if a sector exists in two.
async function findByAddress() {
  const address = $('startAddress').value.trim();
  $('areaChoices').innerHTML = '';
  if (address.length < 6) return showLocError('Please type your full address (house/flat no., street, sector/phase, city).');
  showLocError('');
  const r = await api('/geocode', { method: 'POST', body: { address } });
  if (r.place) return locate(r.place.lat, r.place.lng, `${r.place.name}, ${r.place.city}`, address);
  if (r.candidates) {
    $('areaChoices').innerHTML = '<p class="small" style="width:100%;margin:0">Which area is it in?</p>' + r.candidates.map((c, i) => `<button type="button" class="btn secondary" data-area="${i}">${esc(c.name)}, ${esc(c.city)}</button>`).join('');
    $('areaChoices').querySelectorAll('[data-area]').forEach((b) => b.addEventListener('click', () => {
      const c = r.candidates[Number(b.dataset.area)];
      locate(c.lat, c.lng, `${c.name}, ${c.city}`, address).catch((e) => showLocError(e.message));
    }));
    return;
  }
  showLocError("We couldn't place that address on the map. Tap \"Use my current location\" or choose your area below. Your address is kept for the rider.");
}
$('findAddress').addEventListener('click', () => findByAddress().catch((e) => showLocError(e.message)));
$('startAddress').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); findByAddress().catch((err) => showLocError(err.message)); } });

$('nearestPickup').addEventListener('click', () => {
  if (!navigator.geolocation) return;
  const btn = $('nearestPickup');
  btn.textContent = 'Finding you…';
  navigator.geolocation.getCurrentPosition((pos) => {
    state.lastCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    btn.textContent = '📍 Show the nearest outlet';
    renderOutletList();
  }, () => { btn.textContent = '📍 Show the nearest outlet'; }, { timeout: 15000 });
});

$('locality').addEventListener('change', (e) => {
  const opt = e.target.selectedOptions[0];
  if (!opt.value) return;
  locate(Number(opt.dataset.lat), Number(opt.dataset.lng), opt.textContent).catch((err) => showLocError(err.message));
});

let outletsCache = null;
async function renderOutletList() {
  outletsCache = await api('/outlets');
  const at = state.lastCoords || (state.location?.lat != null ? state.location : null);
  // Road distance estimate, as the server uses (straight line × 1.3).
  const km = (o) => {
    const R = 6371; const r = (d) => (d * Math.PI) / 180;
    const h = Math.sin(r(o.lat - at.lat) / 2) ** 2 + Math.cos(r(at.lat)) * Math.cos(r(o.lat)) * Math.sin(r(o.lng - at.lng) / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 1.3 * 10) / 10;
  };
  const list = [...outletsCache].sort((a, b) => (at ? km(a) - km(b) : 0));
  const nearest = at ? list.find((o) => o.open) : null;
  $('outletList').innerHTML = list.map((o) => `
    <button type="button" class="outlet-opt" data-outlet="${o.id}" ${o.open ? '' : 'disabled'}>
      <span><b>${esc(BRAND.short(o.name))}</b>${at ? ` <span class="small muted">· ${km(o)} km</span>` : ''}<br><span class="small muted">${esc(o.address)} · ${o.opens === o.closes ? 'open 24 hours' : `${o.opens}–${o.closes}`}</span></span>
      <span class="pill ${o === nearest ? 'near' : o.open ? 'open' : 'closed'}">${o === nearest ? 'Nearest' : o.open ? 'Open' : 'Closed'}</span>
    </button>`).join('');
  $('outletList').querySelectorAll('[data-outlet]').forEach((b) => b.addEventListener('click', () => {
    const o = outletsCache.find((x) => x.id === Number(b.dataset.outlet));
    setLocation({ fulfilment: 'pickup', lat: at?.lat ?? null, lng: at?.lng ?? null, label: 'Pickup', outlet: o, distanceKm: null, etaMinutes: 20 });
    closeModal('locModal');
  }));
}

async function loadLocalities() {
  const locs = await api('/localities');
  const byCity = {};
  for (const l of locs) (byCity[l.city] ||= []).push(l);
  $('locality').innerHTML = '<option value="">Select area…</option>' + Object.entries(byCity).map(([city, ls]) =>
    `<optgroup label="${esc(city)}">${ls.map((l) => `<option value="${esc(l.name)}" data-lat="${l.lat}" data-lng="${l.lng}">${esc(l.name)}, ${esc(city)}</option>`).join('')}</optgroup>`).join('');
}

async function setLocation(loc) {
  const changedOutlet = !state.location || state.location.outlet?.id !== loc.outlet.id;
  state.location = loc;
  store.set('location', loc);
  renderHeader();
  if (changedOutlet) await loadMenu();
  else renderCartBar();
  // Location was asked for at checkout: carry on to the cart.
  if (state.checkoutAfterLocation) {
    state.checkoutAfterLocation = false;
    openCartSheet();
  }
}

// Delivery rate card from the server, for showing charges before a location is set.
let siteConfig = null;
function rateCardText() {
  const d = siteConfig?.delivery;
  if (!d) return '';
  return `Delivery: ${rupees(d.baseFee)} for the first ${d.baseKm} km, then ${rupees(d.perKmFee)} per km.`;
}

function renderHeader() {
  const l = state.location;
  if (!l) {
    $('locTitle').textContent = 'Set location';
    $('locSub').textContent = 'or add dishes first';
    $('banner').classList.remove('hidden', 'warn');
      $('banner').textContent = `👋 Choose delivery or pickup to see the menu from your nearest ${BRAND.name}. ${rateCardText()}`;
    return;
  }
  const short = BRAND.short(l.outlet.name);
  $('locTitle').textContent = l.fulfilment === 'delivery' ? `Deliver to: ${l.label}` : `Pickup: ${short}`;
  $('locSub').textContent = l.fulfilment === 'delivery'
    ? `from ${short} · ${l.distanceKm} km${l.deliveryCharge != null ? ` · delivery ${rupees(l.deliveryCharge)}` : ''}`
    : 'tap to change';
  const b = $('banner');
  b.classList.remove('hidden', 'warn');
  b.innerHTML = l.fulfilment === 'delivery'
    ? `🛵 Delivering from <b>${esc(l.outlet.name)}</b> (${l.distanceKm} km) in about <b>${l.etaMinutes} min</b>.`
      + (l.deliveryCharge != null ? ` Delivery: <b>${rupees(l.deliveryCharge)}</b>.` : '')
    : `🏃 Pick up from <b>${esc(l.outlet.name)}</b>, ${esc(l.outlet.address)}. Ready in about <b>20 min</b>.`;
}

$('locChip').addEventListener('click', () => { setModeTab(state.location?.fulfilment || 'delivery'); openModal('locModal'); });

// ---- Menu -------------------------------------------------------------

async function loadMenu() {
  const outletId = state.location?.outlet?.id;
  state.menu = await api('/menu' + (outletId ? `?outletId=${outletId}` : ''));
  // Drop cart entries that this outlet doesn't serve.
  const available = new Set(state.menu.flatMap((c) => c.items.filter((i) => i.available).map((i) => String(i.id))));
  if (outletId) for (const id of Object.keys(state.cart)) if (!available.has(id)) delete state.cart[id];
  saveCart();
  renderMenu();
}

// Dishes sold in two portions are two items, "<dish> (Half)" and "<dish> (Full)".
const PORTION = /\s*\((Half|Full)\)$/;
const portionOf = (name) => { const m = name.match(PORTION); return { dish: name.replace(PORTION, ''), portion: m ? m[1] : null }; };
function groupDishes(items) {
  const byDish = new Map();
  for (const i of items) {
    const { dish } = portionOf(i.name);
    if (!byDish.has(dish)) byDish.set(dish, { dish, veg: i.veg, items: [] });
    byDish.get(dish).items.push(i);
  }
  return [...byDish.values()];
}

const findItem = (id) => state.menu.flatMap((c) => c.items).find((i) => i.id === Number(id));

function qtyControl(item) {
  if (!item.available) return '<span class="small muted">Sold out</span>';
  const q = state.cart[item.id] || 0;
  return q
    ? `<span class="stepper"><button type="button" data-dec="${item.id}" aria-label="Remove one">−</button><span>${q}</span><button type="button" data-inc="${item.id}" aria-label="Add one">+</button></span>`
    : `<button type="button" class="add" data-inc="${item.id}">ADD</button>`;
}

// Same order as WhatsApp: delivery/pickup and outlet first, then the menu.
function startCard() {
  return `<div class="start-card"><h2>How would you like your order?</h2>
    <p class="muted small">We'll find your nearest ${BRAND.name}, show its menu, and tell you the delivery charge before you order.</p>
    <div class="row"><button type="button" class="btn" data-start="delivery">🛵 Delivery</button><button type="button" class="btn secondary" data-start="pickup">🏃 Pickup</button></div></div>`;
}
document.addEventListener('click', (e) => {
  const s = e.target.closest('[data-start]');
  if (s) { setModeTab(s.dataset.start); openModal('locModal'); }
});

function renderMenu() {
  if (!state.location) {
    $('cats').innerHTML = '';
    $('menu').innerHTML = startCard();
    renderCartBar();
    return;
  }
  const cats = state.menu
    .map((c) => ({ ...c, items: c.items.filter((i) => !state.vegOnly || i.veg) }))
    .filter((c) => c.items.length);
  const slug = (s) => 'cat-' + s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  $('cats').innerHTML = cats.map((c) => `<a href="#${slug(c.name)}">${esc(c.name)}</a>`).join('');
  $('menu').innerHTML = cats.map((c) => `
    <section class="cat"><h2 id="${slug(c.name)}">${esc(c.name)}</h2>
      ${groupDishes(c.items).map((d) => {
        const mark = `<span class="vegmark ${d.veg ? '' : 'non'}" title="${d.veg ? 'Veg' : 'Non-veg'}"></span>`;
        const desc = d.items[0].description ? `<div class="desc">${esc(d.items[0].description)}</div>` : '';
        if (d.items.length === 1) {
          const i = d.items[0];
          return `<div class="item ${i.available ? '' : 'unavailable'}">
            <div class="info"><div class="name">${mark}${esc(i.name)}</div>${desc}<div class="price">${rupees(i.price)}</div></div>
            <div data-ctl="${i.id}">${qtyControl(i)}</div>
          </div>`;
        }
        // Half and Full on one card.
        return `<div class="item multi ${d.items.some((i) => i.available) ? '' : 'unavailable'}">
          <div class="info"><div class="name">${mark}${esc(d.dish)}</div>${desc}</div>
          <div class="portions">${d.items.map((i) => `<div class="portion ${i.available ? '' : 'unavailable'}">
            <span><span class="small muted">${esc(portionOf(i.name).portion)}</span><br><b>${rupees(i.price)}</b></span>
            <div data-ctl="${i.id}">${qtyControl(i)}</div></div>`).join('')}</div>
        </div>`;
      }).join('')}
    </section>`).join('');
  renderCartBar();
}

$('vegOnly').checked = state.vegOnly;
$('vegOnly').addEventListener('change', (e) => { state.vegOnly = e.target.checked; store.set('vegOnly', state.vegOnly); renderMenu(); });

function changeQty(id, delta) {
  if (!state.location) { openModal('locModal'); return; }
  const q = Math.max(0, Math.min(20, (state.cart[id] || 0) + delta));
  if (q) state.cart[id] = q; else delete state.cart[id];
  saveCart();
  document.querySelectorAll(`[data-ctl="${id}"]`).forEach((el) => { el.innerHTML = qtyControl(findItem(id)); });
  renderCartBar();
  if (!$('cartModal').classList.contains('hidden')) renderCart();
}

document.addEventListener('click', (e) => {
  const inc = e.target.closest('[data-inc]');
  const dec = e.target.closest('[data-dec]');
  if (inc) changeQty(inc.dataset.inc, 1);
  if (dec) changeQty(dec.dataset.dec, -1);
});

function saveCart() { store.set('cart', state.cart); }

function cartEntries() {
  return Object.entries(state.cart).map(([id, qty]) => ({ item: findItem(id), qty })).filter((e) => e.item);
}

function renderCartBar() {
  const entries = cartEntries();
  const count = entries.reduce((t, e) => t + e.qty, 0);
  const total = entries.reduce((t, e) => t + e.qty * e.item.price, 0);
  $('cartBar').classList.toggle('hidden', count === 0);
  $('cartCount').textContent = `${count} item${count === 1 ? '' : 's'} · ${rupees(total)}`;
}

// ---- Cart & checkout ----------------------------------------------------

let quoteSeq = 0;
async function renderCart() {
  const entries = cartEntries();
  if (!entries.length) { closeModal('cartModal'); return; }
  const l = state.location;
  $('addressBox').classList.toggle('hidden', l.fulfilment !== 'delivery');
  $('payWhen').textContent = l.fulfilment === 'delivery' ? 'delivery' : 'pickup';
  // Online UPI only where the outlet has a UPI ID set up.
  const upiOk = l.outlet.upi !== false;
  $('payUpiOpt').classList.toggle('hidden', !upiOk);
  if (!upiOk) $('payCod').checked = true;
  $('cartHeading').textContent = l.fulfilment === 'delivery' ? `Delivery from ${BRAND.short(l.outlet.name)}` : `Pickup from ${BRAND.short(l.outlet.name)}`;
  $('cartLines').innerHTML = entries.map((e) => `
    <div class="line"><span class="vegmark ${e.item.veg ? '' : 'non'}"></span>
      <span class="n">${esc(e.item.name)}<br><span class="small muted">${rupees(e.item.price)}</span></span>
      <span class="stepper"><button type="button" data-dec="${e.item.id}">−</button><span>${e.qty}</span><button type="button" data-inc="${e.item.id}">+</button></span>
    </div>`).join('');

  const seq = ++quoteSeq;
  try {
    const q = await api('/quote', { method: 'POST', body: quoteBody() });
    if (seq !== quoteSeq) return;
    const short = l.fulfilment === 'delivery' && q.subtotal < q.minDeliveryOrder;
    $('bill').innerHTML = `
      <div><span>Item total</span><span>${rupees(q.subtotal)}</span></div>
      <div><span>Packing</span><span>${rupees(q.packing)}</span></div>
      <div><span>GST (5%)</span><span>${rupees(q.gst)}</span></div>
      ${l.fulfilment === 'delivery' ? `<div><span>Delivery (${q.deliveryKm} km)</span><span>${q.deliveryFee ? rupees(q.deliveryFee) : `FREE <s class="muted">${rupees(q.deliveryCharge)}</s>`}</span></div>` : ''}
      <div class="total"><span>To pay</span><span>${rupees(q.total)}</span></div>
      ${l.fulfilment === 'delivery' && q.deliveryFee && q.freeDeliveryAbove > 0 && q.subtotal < q.freeDeliveryAbove ? `<p class="small muted">Add ${rupees(q.freeDeliveryAbove - q.subtotal)} more for free delivery.</p>` : ''}
      ${short ? `<p class="error">Minimum order for delivery is ${rupees(q.minDeliveryOrder)}.</p>` : ''}`;
    $('placeBtn').disabled = short;
    showCheckoutError('');
  } catch (e) {
    if (seq !== quoteSeq) return;
    $('bill').innerHTML = '';
    showCheckoutError(e.message);
    $('placeBtn').disabled = true;
  }
}

function quoteBody() {
  const l = state.location;
  return {
    fulfilment: l.fulfilment, lat: l.lat, lng: l.lng,
    outletId: l.fulfilment === 'pickup' ? l.outlet.id : undefined,
    items: Object.entries(state.cart).map(([id, qty]) => ({ id: Number(id), qty })),
  };
}

function showCheckoutError(msg) {
  $('checkoutError').textContent = msg;
  $('checkoutError').classList.toggle('hidden', !msg);
}

$('openCart').addEventListener('click', () => {
  if (!state.location) {
    setModeTab('delivery');
    openModal('locModal');
    return;
  }
  openCartSheet();
});

function openCartSheet() {
  const saved = store.get('customer', {});
  for (const k of ['name', 'phone', 'address']) if (saved[k] && !$(k).value) $(k).value = saved[k];
  // Address typed when choosing delivery goes straight into the form.
  if (state.location?.address && !$('address').value) $('address').value = state.location.address;
  showPoints();
  openModal('cartModal');
  renderCart();
}

// Loyalty points saved on this WhatsApp number.
let pointsTimer;
async function showPoints() {
  const digits = $('phone').value.replace(/\D/g, '').slice(-10);
  if (!/^[6-9]\d{9}$/.test(digits)) { $('pointsLine').textContent = ''; return; }
  try {
    const r = await api(`/loyalty?phone=${digits}`);
    $('pointsLine').textContent = r.points > 0
      ? `⭐ You have ${r.points} loyalty points saved. This order adds more.`
      : `⭐ New here? Earn 1 loyalty point for every ₹${r.rupeesPerPoint} you spend.`;
  } catch { $('pointsLine').textContent = ''; }
}
$('phone').addEventListener('input', () => { clearTimeout(pointsTimer); pointsTimer = setTimeout(showPoints, 400); });

$('checkout').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    ...quoteBody(), name: $('name').value, phone: $('phone').value, address: $('address').value, notes: $('notes').value,
    paymentMethod: $('payUpi').checked ? 'upi' : 'cod',
    marketingOptIn: $('marketingOptIn').checked,
  };
  if (!body.name.trim()) return showCheckoutError('Please enter your name.');
  if (!/^\D*(?:\+?91|0)?\D*[6-9](?:\D*\d){9}\D*$/.test(body.phone)) return showCheckoutError('Please enter a valid 10-digit mobile number.');
  if (body.fulfilment === 'delivery' && body.address.trim().length < 5) return showCheckoutError('Please enter your full delivery address.');
  $('placeBtn').disabled = true;
  $('placeBtn').textContent = 'Placing order…';
  try {
    const { code } = await api('/orders', { method: 'POST', body });
    store.set('customer', { name: body.name, phone: body.phone, address: body.address });
    state.cart = {};
    saveCart();
    const past = store.get('orders', []);
    store.set('orders', [code, ...past].slice(0, 10));
    const url = `/track.html?code=${encodeURIComponent(code)}`;
    if (window.RC_NAVIGATE) window.RC_NAVIGATE(url); else location.href = url;
  } catch (err) {
    showCheckoutError(err.message);
    $('placeBtn').disabled = false;
    $('placeBtn').textContent = 'Place order';
  }
});

// ---- Boot ---------------------------------------------------------------

(async function init() {
  loadLocalities().catch(() => {});
  try { siteConfig = await api('/config'); } catch { /* charges still show on the bill */ }
  if (state.location) {
    renderHeader();
    // Re-check assignment: outlet may have closed or been changed since last visit.
    if (state.location.fulfilment === 'delivery') {
      api('/locate', { method: 'POST', body: { lat: state.location.lat, lng: state.location.lng } })
        .then((r) => {
          if (r.outlet) setLocation({ ...state.location, outlet: r.outlet, distanceKm: r.distanceKm, etaMinutes: r.etaMinutes, deliveryCharge: r.deliveryCharge });
          else { $('banner').classList.add('warn'); $('banner').textContent = '⚠️ No outlet can deliver to your saved location right now. Tap the location above to change it or switch to pickup.'; }
        }).catch(() => {});
    }
  } else {
    renderHeader();
    openModal('locModal');
  }
  await loadMenu();
})();
