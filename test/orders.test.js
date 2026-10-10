'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { normalisePhone, ValidationError, deliveryCharge } = require('../src/orders');
const { setup, LUNCH, PLACES } = require('./helpers');

const itemId = (orders, name) => orders.menuFor(null).find((i) => i.name === name).id;

test('normalisePhone accepts common Indian formats', () => {
  assert.equal(normalisePhone('98765 43210'), '+919876543210');
  assert.equal(normalisePhone('+91-98765-43210'), '+919876543210');
  assert.equal(normalisePhone('919876543210'), '+919876543210');
  assert.equal(normalisePhone('09876543210'), '+919876543210');
  assert.equal(normalisePhone('12345'), null);
  assert.equal(normalisePhone('5876543210'), null);
});

test('quote prices from the server menu with packing, GST and the Shadowfax delivery charge', () => {
  const { orders } = setup();
  const noodles = itemId(orders, 'Veg Hakka Noodles'); // ₹119
  const q = orders.quote({ outletId: 1, items: [{ id: noodles, qty: 2 }], fulfilment: 'delivery', distanceKm: 2 });
  assert.equal(q.subtotal, 23800);
  assert.equal(q.packing, 1000);
  assert.equal(q.gst, Math.round((23800 + 1000) * 0.05));
  assert.equal(q.deliveryFee, 4000);
  assert.equal(q.deliveryCharge, 4000);
  assert.equal(q.deliveryPartner, 'Shadowfax');
  assert.equal(q.deliveryKm, 2);
  assert.equal(q.total, 23800 + 1000 + q.gst + 4000);
});

test('Shadowfax rate card: base fare for 3 km, then per extra km rounded up', () => {
  assert.equal(deliveryCharge(0.5), 4000);
  assert.equal(deliveryCharge(3), 4000);
  assert.equal(deliveryCharge(3.1), 5000);
  assert.equal(deliveryCharge(6.2), 8000);
  assert.equal(deliveryCharge(17.7), 19000);
});

test('customers pay the delivery charge by default; optional free-delivery threshold; pickup never pays', (t) => {
  const { orders } = setup();
  const prev = config.pricing.freeDeliveryAbove;
  t.after(() => { config.pricing.freeDeliveryAbove = prev; });
  const comboId = orders.menuFor(null).find((i) => i.name === 'Fried Rice + Chilli Chicken Combo').id;
  assert.equal(orders.quote({ outletId: 1, items: [{ id: comboId, qty: 3 }], fulfilment: 'delivery', distanceKm: 7 }).deliveryFee, 8000);
  config.pricing.freeDeliveryAbove = 49900;
  const combo = itemId(orders, 'Fried Rice + Chilli Chicken Combo'); // ₹239
  assert.equal(orders.quote({ outletId: 1, items: [{ id: combo, qty: 3 }], fulfilment: 'delivery', distanceKm: 7 }).deliveryFee, 0);
  assert.equal(orders.quote({ outletId: 1, items: [{ id: combo, qty: 1 }], fulfilment: 'pickup' }).deliveryFee, 0);
});

test('quote rejects items marked unavailable at that outlet', () => {
  const { db, orders } = setup();
  const momos = itemId(orders, 'Veg Steam Momos (8 pcs)');
  db.prepare('INSERT INTO outlet_unavailable_items VALUES (1, ?)').run(momos);
  assert.throws(() => orders.quote({ outletId: 1, items: [{ id: momos, qty: 1 }], fulfilment: 'pickup' }), ValidationError);
  assert.doesNotThrow(() => orders.quote({ outletId: 2, items: [{ id: momos, qty: 1 }], fulfilment: 'pickup' }));
});

test('createOrder assigns the delivery outlet from coordinates, ignoring a client outletId', () => {
  const { orders } = setup();
  const rice = itemId(orders, 'Chicken Fried Rice');
  const o = orders.createOrder({
    fulfilment: 'delivery', name: 'Aman', phone: '9876543210', address: 'House 12, Sector 22-B',
    ...PLACES.phase7, outletId: 1, items: [{ id: rice, qty: 2 }],
  }, LUNCH);
  assert.match(o.code, /^TK[2-9A-Z]{6}$/);
  assert.equal(o.outlet.name, 'Test Kitchen - Phase 7 Mohali');
  assert.equal(o.status, 'placed');
  assert.equal(o.phone, '+919876543210');
  assert.equal(o.items[0].qty, 2);
});

test('createOrder enforces minimum delivery order and delivery range', () => {
  const { orders } = setup();
  const coke = itemId(orders, 'Coke (300 ml)');
  const base = { fulfilment: 'delivery', name: 'A', phone: '9876543210', address: 'House 1, Sector 22' };
  assert.throws(() => orders.createOrder({ ...base, ...PLACES.sector22, items: [{ id: coke, qty: 1 }] }, LUNCH), { code: 'min_order' });
  assert.throws(() => orders.createOrder({ ...base, ...PLACES.ludhiana, items: [{ id: coke, qty: 10 }] }, LUNCH), { code: 'out_of_range' });
});

test('pickup orders go to the chosen outlet and follow the pickup status flow', () => {
  const { orders } = setup();
  const coke = itemId(orders, 'Coke (300 ml)');
  const o = orders.createOrder({ fulfilment: 'pickup', outletId: 7, name: 'Simran', phone: '9876500000', items: [{ id: coke, qty: 1 }] }, LUNCH);
  assert.equal(o.outlet.id, 7);
  assert.deepEqual(o.nextStatuses, ['accepted', 'cancelled']);
  const seen = [];
  orders.events.on('status', (x) => seen.push(x.status));
  for (const s of ['accepted', 'preparing', 'ready', 'completed']) orders.updateStatus(o.code, s);
  assert.deepEqual(seen, ['accepted', 'preparing', 'ready', 'completed']);
  assert.throws(() => orders.updateStatus(o.code, 'cancelled'), { code: 'bad_transition' });
  assert.throws(() => orders.updateStatus(orders.createOrder({ fulfilment: 'pickup', outletId: 7, name: 'S', phone: '9876500000', items: [{ id: coke, qty: 1 }] }, LUNCH).code, 'out_for_delivery'), { code: 'bad_transition' });
});
