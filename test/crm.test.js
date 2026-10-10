'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCrm } = require('../src/crm');
const { createMenuAdmin } = require('../src/menu-admin');
const { computeAnalytics } = require('../src/analytics');
const { createBot, createSessionStore } = require('../src/whatsapp/bot');
const { notifyOnStatusChange } = require('../src/whatsapp/notify');
const { setup, LUNCH, PLACES } = require('./helpers');

const itemId = (orders, name) => orders.menuFor(null).find((i) => i.name === name).id;

function world() {
  const ctx = setup();
  ctx.db.exec("UPDATE outlets SET opens = '00:00', closes = '00:00'");
  ctx.crm = createCrm({ store: ctx.store, orders: ctx.orders });
  ctx.menu = createMenuAdmin({ store: ctx.store });
  ctx.order = (o = {}, now = LUNCH) => ctx.orders.createOrder({
    fulfilment: 'pickup', outletId: 1, name: 'Simran Kaur', phone: '9876500000',
    items: [{ id: itemId(ctx.orders, 'Chicken Fried Rice'), qty: 2 }], ...o,
  }, now);
  return ctx;
}

test('CRM saves every incoming order and keeps live stats', () => {
  const w = world();
  w.order({ marketingOptIn: true });
  w.order({ name: 'Simran K', outletId: 2 });
  w.order({ phone: '9811122233', name: 'Rohit', fulfilment: 'delivery', address: 'House 5, Sector 22', ...PLACES.sector22, outletId: undefined });
  const { customers, counts } = w.crm.list();
  assert.equal(customers.length, 2);
  const simran = customers.find((c) => c.phone === '+919876500000');
  assert.equal(simran.orders, 2);
  assert.equal(simran.name, 'Simran K');
  assert.equal(simran.optIn, true, 'a later order without the checkbox does not opt them out');
  assert.equal(simran.firstChannel, 'web');
  assert.equal(counts.all, 2);
  const rohit = w.crm.get('9811122233');
  assert.equal(rohit.address, 'House 5, Sector 22');
  assert.deepEqual(rohit.favourites, [{ name: 'Chicken Fried Rice', qty: 2 }]);
  assert.match(w.crm.exportCsv({ optIn: true }), /^name,phone,.*\nSimran K,\+919876500000,2,/s);
});

test('loyalty: 1 point per ₹100 on completion, once; staff redeem with a floor of zero', () => {
  const w = world();
  const o = w.order({ items: [{ id: itemId(w.orders, 'Fried Rice + Chilli Chicken Combo'), qty: 4 }] }); // ₹956 + packing + GST
  assert.equal(w.crm.pointsFor(o.total), Math.floor(o.total / 10000));
  for (const s of ['accepted', 'preparing', 'ready']) w.orders.updateStatus(o.code, s);
  assert.equal(w.crm.balance(o.phone), 0, 'no points before completion');
  w.orders.updateStatus(o.code, 'completed');
  const earned = Math.floor(o.total / 10000);
  assert.equal(w.crm.balance(o.phone), earned);

  assert.throws(() => w.crm.adjustPoints(o.phone, -(earned + 1), 'Too many'), /Only \d+ points available/);
  const after = w.crm.adjustPoints(o.phone, -5, 'Free coke', 'redeem');
  assert.equal(after.points, earned - 5);
  assert.equal(after.ledger[0].kind, 'redeem');
  assert.equal(after.ledger[0].note, 'Free coke');

  const cancelled = w.order();
  w.orders.updateStatus(cancelled.code, 'cancelled');
  assert.equal(w.crm.balance(o.phone), earned - 5, 'cancelled orders earn nothing');
});

test('WhatsApp: points shown when ordering and on completion; offers opt-in and opt-out', () => {
  const w = world();
  const bot = createBot({ orders: w.orders, crm: w.crm, sessions: createSessionStore(w.store), places: () => w.store.localities() });
  const sent = [];
  notifyOnStatusChange({ orders: w.orders, client: { send: async (to, r) => { sent.push(...r); } }, crm: w.crm, log: { error() {} } });
  const say = (m) => bot.handle({ from: '919876511111', name: 'Aman', ...m }, LUNCH);
  say({ type: 'reply', replyId: 'mode:pickup' });
  say({ type: 'reply', replyId: 'outlet:1' });
  say({ type: 'text', text: '3 chicken fried rice' });
  say({ type: 'reply', replyId: 'act:checkout' });
  const r = say({ type: 'reply', replyId: 'act:place' });
  assert.match(r[0].text, /You'll earn \*\d+ loyalty points?\*/);
  assert.ok(r.some((x) => (x.buttons || []).some((b) => b.id === 'act:optin_yes')));
  say({ type: 'reply', replyId: 'act:optin_yes' });
  assert.equal(w.crm.get('919876511111').optIn, true);

  const o = w.orders.latestOrderForPhone('919876511111');
  for (const s of ['accepted', 'preparing', 'ready', 'completed']) w.orders.updateStatus(o.code, s);
  assert.match(sent.at(-1).text, /You earned \*\d+ loyalty points?\*\. Balance: \*\d+\* points/);
  assert.match(say({ type: 'text', text: 'points' })[0].text, /You have \*\d+ loyalty points\*/);
  say({ type: 'text', text: 'stop offers' });
  assert.equal(w.crm.get('919876511111').optIn, false);
});

test('menu: one-click % or ₹ price change with rounding, preview, undo; edit and add dishes', () => {
  const w = world();
  const noodles = w.menu.list().find((i) => i.name === 'Veg Hakka Noodles'); // ₹119
  const preview = w.menu.bulkPrice({ scope: 'category', category: 'Noodles', mode: 'percent', value: 10, round: 5 });
  assert.equal(preview.applied, false);
  assert.equal(preview.changes.find((c) => c.id === noodles.id).newPrice, 13000); // 130.9 -> ₹130
  assert.equal(w.menu.list().find((i) => i.id === noodles.id).price, 11900, 'preview changes nothing');

  const done = w.menu.bulkPrice({ scope: 'category', category: 'Noodles', mode: 'percent', value: 10, round: 5, apply: true });
  assert.equal(done.applied, true);
  assert.equal(w.orders.menuFor(1).find((i) => i.id === noodles.id).price, 13000, 'new price used for orders');
  assert.equal(w.menu.lastChange().note, '+10% on Noodles');

  w.menu.bulkPrice({ scope: 'all', mode: 'amount', value: -10, apply: true });
  assert.equal(w.orders.menuFor(1).find((i) => i.id === noodles.id).price, 12000);
  w.menu.undo();
  assert.equal(w.orders.menuFor(1).find((i) => i.id === noodles.id).price, 13000);
  w.menu.undo();
  assert.equal(w.orders.menuFor(1).find((i) => i.id === noodles.id).price, 11900);
  assert.throws(() => w.menu.undo(), /no price change to undo/);
  assert.throws(() => w.menu.bulkPrice({ mode: 'percent', value: -95 }), /between -90% and \+200%/);

  w.menu.update(noodles.id, { price: 125, active: false });
  assert.equal(w.orders.menuFor(1).find((i) => i.id === noodles.id), undefined, 'inactive dish leaves the menu');
  const added = w.menu.add({ name: 'Chilli Garlic Momos', category: 'Momos', price: 149, veg: true });
  assert.equal(w.orders.menuFor(1).find((i) => i.id === added.id).price, 14900);
  assert.throws(() => w.menu.add({ name: '', category: 'Momos', price: 10 }), /name is required/);
});

test('analytics: KPIs, comparison, outlet/item/category, heatmap, splits', () => {
  const w = world();
  const day = (d, h = 13) => new Date(`2026-10-${String(d).padStart(2, '0')}T${String(h - 6).padStart(2, '0')}:30:00Z`); // h:00 IST
  w.order({}, day(1));
  w.order({ outletId: 2, items: [{ id: itemId(w.orders, 'Veg Hakka Noodles'), qty: 3 }] }, day(2, 20));
  w.order({ phone: '9811100001', name: 'New Guy' }, day(5, 20));
  const c = w.order({ phone: '9811100002' }, day(6));
  w.orders.updateStatus(c.code, 'cancelled');
  w.order({}, day(25)); // previous period for 01–07 comparison? no: earlier window is 24–30 Sep

  const a = computeAnalytics(w.store, { from: '2026-10-01', to: '2026-10-07' }, day(7));
  assert.equal(a.summary.orders, 3);
  assert.equal(a.summary.cancelled, 1);
  assert.equal(a.summary.customers, 2);
  assert.equal(a.summary.newCustomers, 2);
  assert.equal(a.daily.length, 7);
  assert.equal(a.daily[1].orders, 1);
  assert.equal(a.outlets[0].orders + a.outlets[1].orders, 3);
  assert.equal(a.items.find((i) => i.name === 'Veg Hakka Noodles').qty, 3);
  assert.equal(a.items[0].rank, 1);
  assert.ok(a.categories.some((x) => x.category === 'Rice'));
  assert.equal(a.heatmap.flat().reduce((t, n) => t + n, 0), 3);
  assert.equal(a.heatmap[4][20], 1, 'Fri 2 Oct, 8 pm IST');
  assert.equal(a.channels[0].key, 'web');
  assert.ok(a.notSold.length > 20);

  const one = computeAnalytics(w.store, { from: '2026-10-01', to: '2026-10-07', outletId: 2 }, day(7));
  assert.equal(one.summary.orders, 1);
  assert.equal(one.outlets.length, 1);
  const later = computeAnalytics(w.store, { from: '2026-10-22', to: '2026-10-28' }, day(28));
  assert.equal(later.summary.orders, 1);
  assert.equal(later.summary.returningCustomers, 1);
});

test('analytics: rush hours, kitchen/delivery speed from status times, dish combinations', () => {
  const w = world();
  const at = (h, m = 0) => new Date(Date.UTC(2026, 9, 2, h - 6, 30 + m)); // h:mm IST on Fri 2 Oct
  const both = [{ id: itemId(w.orders, 'Veg Hakka Noodles'), qty: 1 }, { id: itemId(w.orders, 'Veg Manchurian Gravy'), qty: 1 }];
  const a = w.order({ items: both }, at(20));
  const b = w.order({ items: both, phone: '9811100003' }, at(20, 10));
  w.order({}, at(13));
  // a: accepted after 2 min, ready after 15 more, collected 10 min later.
  w.orders.updateStatus(a.code, 'accepted', at(20, 2));
  w.orders.updateStatus(a.code, 'preparing', at(20, 3));
  w.orders.updateStatus(a.code, 'ready', at(20, 17));
  w.orders.updateStatus(a.code, 'completed', at(20, 27));
  void b;

  const r = computeAnalytics(w.store, { from: '2026-10-01', to: '2026-10-07' }, at(23));
  assert.equal(r.rush.hourly[20].orders, 2);
  assert.deepEqual(r.rush.busiestSlots[0], { day: 'Fri', hour: 20, orders: 2 });
  assert.equal(r.rush.outletPeaks.find((p) => p.outletId === 1).peakHour, 20);
  assert.equal(r.speed.acceptMin, 2);
  assert.equal(r.speed.prepMin, 15);
  assert.equal(r.speed.byHour[20].prepMin, 15);
  const combo = r.combinations[0];
  assert.deepEqual(combo.items, ['Veg Hakka Noodles', 'Veg Manchurian Gravy']);
  assert.equal(combo.orders, 2);
  assert.equal(combo.withA, 1);
});
