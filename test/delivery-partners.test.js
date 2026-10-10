'use strict';

// Several delivery partners: quotes, selection, fallbacks, partner webhooks.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createDispatcher } = require('../src/delivery/dispatcher');
const { createSelector } = require('../src/delivery/selector');
const { createBorzoClient, buildBorzoOrder, parseBorzoCallback, validBorzoSignature } = require('../src/delivery/borzo');
const { createPorterClient, parsePorterCallback } = require('../src/delivery/porter');
const { setup, PLACES } = require('./helpers');

const tick = () => new Promise((r) => setImmediate(r));
const quiet = { error() {} };

function world(payment = 'cod') {
  const ctx = setup();
  ctx.db.exec("UPDATE outlets SET opens = '00:00', closes = '00:00', sfx_store_code = 'SFX-' || id");
  const rice = ctx.orders.menuFor(null).find((i) => i.name === 'Chicken Fried Rice').id;
  ctx.order = () => ctx.orders.createOrder({
    fulfilment: 'delivery', name: 'Aman Gill', phone: '9876543210', address: 'House 12, Sector 22-B', ...PLACES.sector22,
    items: [{ id: rice, qty: 2 }], paymentMethod: payment,
  });
  return ctx;
}

// A fake partner: fixed price, can refuse, records bookings and cancellations.
function partner(name, { price, cod = true, etaMin = null, ok = true, bookFails = false } = {}) {
  const p = {
    name, label: name[0].toUpperCase() + name.slice(1), supportsCod: cod, booked: [], cancelled: [],
    quote: async () => (ok ? { ok: true, price, etaMin } : { ok: false, reason: 'no riders nearby' }),
    book: async (o) => { if (bookFails) throw new Error('server error'); p.booked.push(o.code); return { ref: `${name}-${p.booked.length}`, status: 'ACCEPTED' }; },
    cancel: async (ref) => { p.cancelled.push(ref); },
  };
  return p;
}

test('selector: cheapest wins, but a slow partner pays for the wait; COD and setup filter partners', async () => {
  const { orders, store, order } = world('cod');
  const o = order();
  const outlet = store.outlet(o.outlet_id);
  const sel = createSelector({ store, minuteValue: 300 });
  const cheapSlow = partner('borzo', { price: 5000, etaMin: 15 }); // ₹50 + 15 min × ₹3 = ₹95
  const pricierFast = partner('shadowfax', { price: 6000, etaMin: 3 }); // ₹60 + 3 min × ₹3 = ₹69
  const noCod = partner('porter', { price: 4000, cod: false });
  const { ranked, rejected } = await sel.rank(o, outlet, [cheapSlow, pricierFast, noCod]);
  assert.deepEqual(ranked.map((r) => r.provider.name), ['shadowfax', 'borzo']);
  assert.deepEqual(rejected.map((r) => [r.name, r.reason]), [['porter', 'no cash on delivery']]);

  // Prepaid: Porter is back in, and cheapest overall.
  const paid = { ...o, payment_status: 'paid' };
  assert.equal((await sel.rank(paid, outlet, [cheapSlow, pricierFast, noCod])).ranked[0].provider.name, 'porter');

  const notSetUp = { ...partner('shadowfax', { price: 1 }), ready: () => false };
  assert.match((await sel.rank(o, outlet, [notSetUp])).rejected[0].reason, /has no Shadowfax store code/);
  const slowQuote = { ...partner('borzo', { price: 1 }), quote: () => new Promise(() => {}) };
  const timed = await createSelector({ store, timeoutMs: 20 }).rank(o, outlet, [slowQuote]);
  assert.match(timed.rejected[0].reason, /did not answer in time/);
});

test('selector learns from history: a partner that is slow to assign riders ranks lower', async () => {
  const { store, order } = world();
  const since = (min) => new Date(Date.now() - min * 60000).toISOString();
  // Borzo took ~20 min to find riders this week; Shadowfax ~2 min.
  for (let i = 0; i < 6; i++) {
    store.upsertDelivery(order().id, { provider: 'borzo', status: 'DELIVERED', booked_at: since(120), allotted_at: since(100), updated_at: since(1) });
    store.upsertDelivery(order().id, { provider: 'shadowfax', status: 'DELIVERED', booked_at: since(120), allotted_at: since(118), updated_at: since(1) });
  }
  const o = order();
  const outlet = store.outlet(o.outlet_id);
  const { ranked } = await createSelector({ store }).rank(o, outlet, [partner('borzo', { price: 4500 }), partner('shadowfax', { price: 5500 })]);
  assert.deepEqual(ranked.map((r) => [r.provider.name, Math.round(r.etaMin)]), [['shadowfax', 2], ['borzo', 20]]);
});

test('dispatcher: books the best partner, falls through refusals, records the comparison', async () => {
  const { orders, store, order } = world();
  const broken = partner('shadowfax', { price: 3000, bookFails: true });
  const borzo = partner('borzo', { price: 5000 });
  const porter = partner('porter', { price: 2000, cod: false });
  const d = createDispatcher({ orders, store, providers: [broken, borzo, porter], log: quiet });
  const o = order();
  orders.updateStatus(o.code, 'accepted');
  for (let i = 0; i < 5; i++) await tick();
  const del = orders.getOrder(o.code).delivery;
  assert.equal(del.provider, 'borzo', 'Shadowfax refused the booking, Porter has no COD');
  assert.equal(del.providerLabel, 'Borzo');
  assert.equal(del.price, 5000);
  assert.deepEqual(del.tried, ['shadowfax', 'borzo']);
  assert.deepEqual(del.quotes.map((q) => q.name), ['shadowfax', 'borzo', 'porter']);
  assert.equal(del.quotes.find((q) => q.name === 'porter').reason, 'no cash on delivery');
  // An update from a partner we didn't book is ignored.
  assert.equal(d.handleUpdate('shadowfax', { ref: 'borzo-1', status: 'DELIVERED' }), null);
});

test('no rider in time, or the partner cancels: the next partner takes over automatically', async () => {
  const { orders, store, order } = world();
  const shadowfax = partner('shadowfax', { price: 4000 });
  const borzo = partner('borzo', { price: 5000 });
  const d = createDispatcher({ orders, store, providers: [shadowfax, borzo], reassignMinutes: 8, log: quiet });
  const o = order();
  orders.updateStatus(o.code, 'accepted');
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(orders.getOrder(o.code).delivery.provider, 'shadowfax');

  // 9 minutes later nobody has picked it up: cancel at Shadowfax, book Borzo.
  await d.sweep(new Date(Date.now() + 9 * 60000));
  let del = orders.getOrder(o.code).delivery;
  assert.deepEqual(shadowfax.cancelled, ['shadowfax-1']);
  assert.equal(del.provider, 'borzo');
  assert.deepEqual(del.tried, ['shadowfax', 'borzo']);

  // Borzo assigns a rider, then cancels: nobody left, so it stays with staff.
  d.handleUpdate('borzo', { ref: 'borzo-1', status: 'ALLOTTED', rider: { name: 'Vikas', phone: '9876500066' } });
  assert.ok(orders.getOrder(o.code).delivery.allotted_at);
  d.handleUpdate('borzo', { ref: 'borzo-1', status: 'CANCELLED', error: 'Courier had an accident' });
  for (let i = 0; i < 5; i++) await tick();
  del = orders.getOrder(o.code).delivery;
  assert.equal(del.status, 'CANCELLED');
  assert.equal(del.error, 'Courier had an accident');

  // A second order: Shadowfax cancels, Borzo picks it up on its own.
  const o2 = order();
  orders.updateStatus(o2.code, 'accepted');
  for (let i = 0; i < 5; i++) await tick();
  d.handleUpdate('shadowfax', { ref: 'shadowfax-2', status: 'CANCELLED' });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(orders.getOrder(o2.code).delivery.provider, 'borzo');
});

test('Borzo: order body (COD at the drop), quote warnings, callbacks and signature', async () => {
  const { store, order } = world('cod');
  const o = order();
  const outlet = store.outlet(o.outlet_id);
  const body = buildBorzoOrder(o, outlet);
  assert.equal(body.vehicle_type_id, 8);
  assert.equal(body.points[0].contact_person.phone, '0000000001');
  assert.equal(body.points[1].client_order_id, o.code);
  assert.equal(body.points[1].taking_amount, (o.total / 100).toFixed(2));

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init.headers['X-DV-Auth-Token']]);
    if (url.endsWith('/calculate-order')) return new Response(JSON.stringify({ is_successful: true, order: { payment_amount: '62.50' }, warnings: [] }));
    return new Response(JSON.stringify({ is_successful: true, order: { order_id: 777, payment_amount: '62.50', points: [{}, { tracking_url: 'https://t/777' }] } }));
  };
  const borzo = createBorzoClient({ token: 'tok', baseUrl: 'https://b.example/api', fetchImpl });
  assert.deepEqual(await borzo.quote(o, outlet), { ok: true, price: 6250, etaMin: null });
  assert.deepEqual(await borzo.book(o, outlet), { ref: '777', status: 'ACCEPTED', trackUrl: 'https://t/777', price: 6250, rider: null });
  assert.deepEqual(calls.map((c) => c[1]), ['tok', 'tok']);
  const warned = createBorzoClient({ token: 't', fetchImpl: async () => new Response(JSON.stringify({ is_successful: true, order: { payment_amount: '50' }, warnings: ['invalid_region'] })) });
  assert.deepEqual(await warned.quote(o, outlet), { ok: false, reason: 'Borzo: invalid_region' });

  const u = parseBorzoCallback({ event_type: 'delivery_changed', delivery: { order_id: 777, client_order_id: o.code, status: 'parcel_picked_up', tracking_url: 'https://t/777' } });
  assert.deepEqual([u.ref, u.clientOrderId, u.status], ['777', o.code, 'DISPATCHED']);
  const c = parseBorzoCallback({ event_type: 'order_changed', order: { order_id: 777, status: 'active', courier: { name: 'Ravi', surname: 'Kumar', phone: '919800000000', latitude: '30.7', longitude: '76.7' } } });
  assert.deepEqual([c.status, c.rider.name, c.rider.lat], ['ALLOTTED', 'Ravi Kumar', 30.7]);

  const raw = Buffer.from(JSON.stringify({ event_type: 'order_changed' }));
  const sig = crypto.createHmac('sha256', 'secret').update(raw).digest('hex');
  assert.equal(validBorzoSignature(raw, sig, 'secret'), true);
  assert.equal(validBorzoSignature(raw, sig, 'other'), false);
  assert.equal(validBorzoSignature(raw, 'nope', 'secret'), false);
});

test('Porter: two-wheeler quote, prepaid only, webhook statuses', async () => {
  const { store, order } = world('upi');
  const o = order();
  const outlet = store.outlet(o.outlet_id);
  const fetchImpl = async () => new Response(JSON.stringify({ vehicles: [{ type: 'Truck', fare: { minor_amount: 90000 } }, { type: '2 Wheeler', fare: { minor_amount: 5400 }, eta: { value: 6 } }] }));
  const porter = createPorterClient({ apiKey: 'k', fetchImpl });
  assert.equal(porter.supportsCod, false);
  assert.deepEqual(await porter.quote(o, outlet), { ok: true, price: 5400, etaMin: 6 });
  const u = parsePorterCallback({ order_id: 'CRN1', request_id: `${o.code}-1`, status: 'accepted', partner_info: { name: 'Sunil', mobile: { mobile_number: '9800000001' }, location: { lat: 30.7, long: 76.7 } } });
  assert.deepEqual([u.ref, u.clientOrderId, u.status, u.rider.phone, u.rider.lng], ['CRN1', o.code, 'ALLOTTED', '9800000001', 76.7]);
  assert.equal(parsePorterCallback({ order_id: 'CRN1', status: 'ended' }).status, 'DELIVERED');
});
