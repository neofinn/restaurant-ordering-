'use strict';

// The browser demo runs the real services on the in-memory store; make sure
// it behaves like SQLite for the flows the demo exercises.

const test = require('node:test');
const assert = require('node:assert/strict');
const seed = require('./fixtures/seed');
const { createMemoryStore } = require('../src/store/memory');
const { createOrderService } = require('../src/orders');
const { createHandoffService } = require('../src/handoff');
const { createBot, createSessionStore } = require('../src/whatsapp/bot');
const { LUNCH, PLACES } = require('./helpers');

test('memory store: WhatsApp typed order, status updates, stock-outs and handoff', () => {
  const store = createMemoryStore(seed);
  const orders = createOrderService(store);
  const handoffs = createHandoffService(store);
  const bot = createBot({ orders, handoffs, sessions: createSessionStore(store) });
  const say = (m) => bot.handle({ from: '919811100000', name: 'Isha', ...m }, LUNCH);

  say({ type: 'location', location: PLACES.panchkula5 });
  say({ type: 'text', text: '2 veg manchurian gravy, 2 schezwan fried rice extra spicy' });
  say({ type: 'reply', replyId: 'act:checkout' });
  say({ type: 'text', text: 'House 77, Sector 5, Panchkula' });
  say({ type: 'reply', replyId: 'act:place' });

  const o = orders.latestOrderForPhone('919811100000');
  assert.equal(o.outlet.name, 'Test Kitchen - Sector 11 Panchkula');
  assert.equal(o.items.find((i) => i.name === 'Schezwan Fried Rice').note, 'extra spicy');
  assert.equal(orders.listOrders({ outletId: o.outlet_id, statuses: ['placed'] }).length, 1);
  assert.equal(orders.updateStatus(o.code, 'accepted').status, 'accepted');
  assert.equal(store.summarySince('2000-01-01')[0].orders, 1);

  store.setAvailability(1, 1, false);
  assert.equal(orders.menuFor(1)[0].available, false);
  assert.equal(orders.menuFor(2)[0].available, true);

  say({ type: 'text', text: 'talk to someone' });
  const h = handoffs.list({ outletId: o.outlet_id })[0];
  assert.equal(h.phone, '919811100000');
  handoffs.addMessage(h.id, 'out', 'Hello!');
  assert.equal(handoffs.close(h.id), true);
  assert.equal(handoffs.openForPhone('919811100000'), null);
});

test('memory store: stock counts and outlet PIN logins behave like SQLite', () => {
  const { createStockService } = require('../src/stock');
  const { createStaffAuth } = require('../src/staff-auth');
  const store = createMemoryStore(seed);
  const orders = createOrderService(store);
  const stock = createStockService({ store, orders });
  const lemonade = orders.menuFor(1).find((i) => i.name === 'Masala Lemonade');
  stock.set({ outletId: 1, itemId: lemonade.id, remaining: 2 });
  const o = orders.createOrder({ fulfilment: 'pickup', outletId: 1, name: 'Isha', phone: '9811100000', items: [{ id: lemonade.id, qty: 2 }] }, LUNCH);
  assert.equal(orders.menuFor(1).find((i) => i.id === lemonade.id).available, false);
  orders.updateStatus(o.code, 'cancelled', LUNCH);
  assert.equal(stock.board().items.find((i) => i.id === lemonade.id).outlets[1].remaining, 2);

  const auth = createStaffAuth({ store, adminToken: 'hq' });
  auth.setPin(1, '2468');
  const { token } = auth.login(1, '2468');
  assert.deepEqual(auth.resolve(token), { role: 'outlet', outletId: 1 });
  assert.deepEqual(auth.resolve('hq'), { role: 'admin' });
  assert.equal(auth.resolve('nope'), null);
});
