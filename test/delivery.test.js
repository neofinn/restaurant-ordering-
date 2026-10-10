'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDispatcher } = require('../src/delivery/dispatcher');
const { createShadowfaxClient, buildOrderPayload } = require('../src/delivery/shadowfax');
const { createSimulatedShadowfax } = require('../src/delivery/simulator');
const { setup, PLACES } = require('./helpers');

const tick = () => new Promise((r) => setImmediate(r));

function deliveryOrder(orders, payment = 'cod') {
  const rice = orders.menuFor(null).find((i) => i.name === 'Chicken Fried Rice').id;
  return orders.createOrder({
    fulfilment: 'delivery', name: 'Aman Gill', phone: '9876543210', address: 'House 12, Sector 22-B', ...PLACES.sector22,
    items: [{ id: rice, qty: 2, note: 'extra spicy' }], paymentMethod: payment,
  });
}

function withOutletsOpen(db) {
  db.exec("UPDATE outlets SET opens = '00:00', closes = '00:00', sfx_store_code = 'SFX-' || id");
}

test('Shadowfax order payload: store code, COD amount, customer drop point, items', () => {
  const { db, orders, store } = setup();
  withOutletsOpen(db);
  const o = deliveryOrder(orders);
  const p = buildOrderPayload(o, store.outlet(o.outlet_id));
  assert.equal(p.store_code, 'SFX-1');
  assert.equal(p.pickup_contact_number, '0000000001');
  assert.deepEqual(p.order_details, { order_value: (o.total / 100).toFixed(2), paid: false, client_order_id: o.code });
  assert.equal(p.customer_details.contact_number, '9876543210');
  assert.equal(p.customer_details.latitude, PLACES.sector22.lat);
  assert.deepEqual(p.product_details, [{ id: o.items[0].item_id, name: 'Chicken Fried Rice (extra spicy)', price: 159, quantity: 2 }]);
});

test('Shadowfax client: serviceability then create, token auth, and failures surface', async () => {
  const { db, orders, store } = setup();
  withOutletsOpen(db);
  const o = deliveryOrder(orders);
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization, body: JSON.parse(init.body) });
    if (url.endsWith('/api/v2/store_serviceability/')) return new Response(JSON.stringify({ is_serviceable: true }));
    return new Response(JSON.stringify({ sfx_order_id: 98765, status: 'ACCEPTED', track_url: 'https://t/1' }));
  };
  const sfx = createShadowfaxClient({ token: 'tkn', baseUrl: 'https://hl.example/', fetchImpl: fakeFetch });
  const r = await sfx.book(o, store.outlet(o.outlet_id));
  assert.deepEqual(r, { ref: '98765', status: 'ACCEPTED', trackUrl: 'https://t/1', rider: null });
  assert.deepEqual(calls.map((c) => [c.method, c.url, c.auth]), [
    ['PUT', 'https://hl.example/api/v2/store_serviceability/', 'Token tkn'],
    ['POST', 'https://hl.example/api/v2/stores/orders/', 'Token tkn'],
  ]);
  assert.equal(calls[0].body.drop_latitude, PLACES.sector22.lat);

  const notServiceable = createShadowfaxClient({ token: 't', baseUrl: 'https://x', fetchImpl: async () => new Response(JSON.stringify({ is_serviceable: false })) });
  await assert.rejects(notServiceable.book(o, store.outlet(o.outlet_id)), /no rider/);
  const noId = createShadowfaxClient({ token: 't', baseUrl: 'https://x', fetchImpl: async (u) => new Response(JSON.stringify(u.includes('serviceability') ? { is_serviceable: true } : { message: 'Invalid store code' })) });
  await assert.rejects(noId.book(o, store.outlet(o.outlet_id)), /Invalid store code/);
});

test('dispatcher: books on accept, follows callbacks to delivered, notifies quietly in between', async () => {
  const { db, orders, store } = setup();
  withOutletsOpen(db);
  const booked = [];
  const provider = { name: 'shadowfax', book: async (o) => { booked.push(o.code); return { ref: 'SFX1', status: 'ACCEPTED', trackUrl: 'https://t/x', rider: null }; }, cancel: async () => {} };
  const d = createDispatcher({ orders, store, provider, log: { error() {} } });
  const statusEvents = [];
  orders.events.on('status', (o, meta) => statusEvents.push([o.status, !!meta.quiet]));
  const changes = [];
  d.events.on('delivery', (o, change) => changes.push(change));

  const o = deliveryOrder(orders);
  orders.updateStatus(o.code, 'accepted');
  await tick();
  assert.deepEqual(booked, [o.code]);
  assert.equal(orders.getOrder(o.code).delivery.status, 'ACCEPTED');

  d.handleCallback({ sfx_order_id: 'SFX1', order_status: 'ALLOTED', rider_name: 'Gurpreet', rider_contact: '9876500011', rider_latitude: 30.74, rider_longitude: 76.78 });
  let cur = orders.getOrder(o.code);
  assert.equal(cur.delivery.status, 'ALLOTTED');
  assert.equal(cur.delivery.rider_name, 'Gurpreet');
  assert.equal(cur.delivery.label, 'Rider assigned');
  assert.equal(cur.delivery.collect, cur.total);

  d.handleCallback({ sfx_order_id: 'SFX1', order_status: 'ALLOTED', rider_latitude: 30.745, rider_longitude: 76.781 });
  assert.equal(orders.getOrder(o.code).delivery.rider_lat, 30.745);

  d.handleCallback({ sfx_order_id: 'SFX1', order_status: 'DISPATCHED' });
  assert.equal(orders.getOrder(o.code).status, 'out_for_delivery');
  d.handleCallback({ client_order_id: o.code, order_status: 'DELIVERED' });
  cur = orders.getOrder(o.code);
  assert.equal(cur.status, 'completed');
  assert.deepEqual(statusEvents, [['accepted', false], ['preparing', true], ['out_for_delivery', false], ['completed', false]]);
  assert.deepEqual(changes, ['booking', 'booked', 'allotted', 'location', 'dispatched', 'delivered']);
  assert.equal(d.handleCallback({ sfx_order_id: 'nope', order_status: 'DELIVERED' }), null);
});

test('dispatcher: booking failure and partner cancellation leave the order with staff', async () => {
  const { db, orders, store } = setup();
  withOutletsOpen(db);
  let fail = true;
  const provider = { name: 'shadowfax', label: 'Shadowfax', ready: (outlet) => Boolean(outlet.sfx_store_code), book: async () => { if (fail) throw new Error('Shadowfax has no rider for this address right now'); return { ref: 'R2', status: 'ACCEPTED' }; }, cancel: async () => {} };
  const d = createDispatcher({ orders, store, provider, log: { error() {} } });
  const o = deliveryOrder(orders, 'upi');
  orders.setPayment(o.code, 'paid');
  orders.updateStatus(o.code, 'accepted');
  await tick();
  assert.equal(orders.getOrder(o.code).delivery.status, 'FAILED');
  assert.match(orders.getOrder(o.code).delivery.error, /no rider/);

  fail = false;
  await d.book(o.code);
  assert.equal(orders.getOrder(o.code).delivery.ref, 'R2');
  d.handleCallback({ sfx_order_id: 'R2', order_status: 'CANCELLED', comments: 'Rider not available' });
  assert.equal(orders.getOrder(o.code).delivery.error, 'Rider not available');
  assert.equal(orders.getOrder(o.code).status, 'accepted');

  d.useOwnRider(o.code);
  assert.equal(orders.getOrder(o.code).delivery.label, 'Outlet rider');
  assert.equal(d.handleCallback({ sfx_order_id: 'R2', order_status: 'DELIVERED' }), null);

  db.exec('UPDATE outlets SET sfx_store_code = NULL');
  const o2 = deliveryOrder(orders);
  await d.book(o2.code);
  assert.match(orders.getOrder(o2.code).delivery.error, /has no Shadowfax store code/);
});

test('simulator replays a full Shadowfax delivery', async () => {
  const { db, orders, store } = setup();
  withOutletsOpen(db);
  const timers = [];
  let d;
  const sim = createSimulatedShadowfax({ onCallback: (p) => d.handleCallback(p), schedule: (fn, ms) => timers.push([ms, fn]) });
  d = createDispatcher({ orders, store, provider: sim, log: { error() {} } });
  const o = deliveryOrder(orders);
  orders.updateStatus(o.code, 'accepted');
  await tick();
  timers.sort((a, b) => a[0] - b[0]).forEach(([, fn]) => fn());
  const done = orders.getOrder(o.code);
  assert.equal(done.status, 'completed');
  assert.equal(done.delivery.status, 'DELIVERED');
  assert.ok(done.delivery.rider_name);
});
