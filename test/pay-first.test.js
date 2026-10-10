'use strict';

// "Pay now (UPI)" orders reach the kitchen only once paid: confirmed by
// WhatsApp, by staff seeing the money, or by switching to cash. Unpaid ones are
// cancelled after the payment window.

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { createBot, createSessionStore } = require('../src/whatsapp/bot');
const { createHandoffService } = require('../src/handoff');
const { notifyOnStatusChange, notifyOnPayment } = require('../src/whatsapp/notify');
const { computeAnalytics } = require('../src/analytics');
const { setup, LUNCH, PLACES } = require('./helpers');

const MIN = 60000;
const texts = (replies) => replies.map((r) => r.text || '').join('\n');

function world(t) {
  const prev = config.whatsapp.payments;
  config.whatsapp.payments = true;
  t.after(() => { config.whatsapp.payments = prev; });
  const ctx = setup();
  const { store, orders } = ctx;
  const bot = createBot({ orders, handoffs: createHandoffService(store), sessions: createSessionStore(store), baseUrl: 'https://order.example' });
  const sent = [];
  const client = { send: async (to, r) => { sent.push(...r); } };
  notifyOnStatusChange({ orders, client, log: { error() {} } });
  notifyOnPayment({ orders, client, log: { error() {} } });
  const from = '919876543210';
  const say = (m, at = LUNCH) => bot.handle({ from, name: 'Aman', ...m }, at);
  const upiOrder = () => {
    say({ type: 'text', text: '2 chilli chicken dry' });
    say({ type: 'reply', replyId: 'act:checkout' });
    say({ type: 'location', location: PLACES.phase7 });
    say({ type: 'text', text: 'Flat 3, Phase 7, near market' });
    const replies = say({ type: 'reply', replyId: 'act:place_upi' });
    return { replies, order: orders.latestOrderForPhone(from) };
  };
  return { ...ctx, say, upiOrder, sent, from };
}

test('pay now: the order waits for payment, the outlet does not get it as a new order', (t) => {
  const { orders, upiOrder } = world(t);
  const { replies, order } = upiOrder();
  assert.equal(order.status, 'awaiting_payment');
  assert.equal(order.statusLabel, 'Waiting for payment');
  assert.deepEqual(order.nextStatuses, ['cancelled'], 'staff can only cancel it, not accept it');
  assert.doesNotMatch(texts(replies), /Order placed|confirmed/);
  assert.match(texts(replies), /Pay ₹[\d.,]+ to confirm it/);
  assert.throws(() => orders.updateStatus(order.code, 'accepted'), /Cannot move order/);
});

test('no rider is booked for an order that is not paid yet', async (t) => {
  const { orders, store, upiOrder } = world(t);
  const { createDispatcher } = require('../src/delivery/dispatcher');
  const booked = [];
  const d = createDispatcher({ orders, store, providers: [{ name: 'p', label: 'P', book: async (o) => { booked.push(o.code); return { ref: 'R1' }; }, cancel: async () => {} }], log: { error() {} } });
  const { order } = upiOrder();
  assert.equal((await d.book(order.code)).delivery, null);
  assert.deepEqual(booked, []);
});

test('paid in WhatsApp: confirmed straight away and sent to the kitchen', (t) => {
  const { orders, say, upiOrder, from } = world(t);
  const { order } = upiOrder();
  const r = say({ type: 'payment', from, referenceId: order.code, status: 'success', amount: order.total, transactionId: 'UTR1' });
  const o = orders.getOrder(order.code);
  assert.equal(o.status, 'placed');
  assert.equal(o.payment_status, 'paid');
  assert.match(r[0].text, /Payment of ₹[\d.,]+ received \(UPI ref UTR1\)/);
  assert.match(r[0].text, new RegExp(`Order \\*${order.code}\\* is confirmed and sent to the kitchen`));
  // The outlet can now accept it as usual.
  assert.equal(orders.updateStatus(order.code, 'accepted').status, 'accepted');
});

test('paid by QR: staff confirm the money, the customer then gets the confirmation', (t) => {
  const { orders, say, upiOrder, sent } = world(t);
  const { order } = upiOrder();
  say({ type: 'reply', replyId: 'act:paid' });
  assert.equal(orders.getOrder(order.code).status, 'awaiting_payment', 'a claim alone does not place it');

  // Staff can't see it: the customer is told the order is on hold, with options.
  orders.setPayment(order.code, 'pending');
  assert.match(sent.at(-1).text, /on hold until it arrives/);
  assert.deepEqual(sent.at(-1).buttons.map((b) => b.id), ['act:pay_again', 'act:pay_cash']);

  say({ type: 'reply', replyId: 'act:paid' });
  orders.setPayment(order.code, 'paid');
  assert.equal(orders.getOrder(order.code).status, 'placed');
  assert.match(sent.at(-1).text, /Payment of ₹[\d.,]+ received\. 🎉 Order \*\w+\* is confirmed/);
});

test('switching to cash confirms the order', (t) => {
  const { orders, say, upiOrder } = world(t);
  const { order } = upiOrder();
  const r = say({ type: 'reply', replyId: 'act:pay_cash' });
  const o = orders.getOrder(order.code);
  assert.equal(o.status, 'placed');
  assert.equal(o.payment_status, 'cod');
  assert.match(texts(r), /pay ₹[\d.,]+ by cash\/UPI when your order arrives/);
  assert.match(texts(r), /is confirmed and sent to the kitchen/);
});

test('not paid in time: cancelled, stock back, customer told; a late payment still goes through', (t) => {
  const { orders, store, say, upiOrder, sent, from } = world(t);
  const { order } = upiOrder();
  const item = order.items[0];
  store.setStock(order.outlet_id, item.item_id, 10, LUNCH.toISOString());
  const left = () => store.stockFor(order.outlet_id).find((s) => s.item_id === item.item_id).remaining;

  assert.deepEqual(orders.expireUnpaid(new Date(LUNCH.getTime() + (config.payments.windowMinutes - 1) * MIN)), [], 'still inside the window');
  const [expired] = orders.expireUnpaid(new Date(LUNCH.getTime() + (config.payments.windowMinutes + 1) * MIN));
  assert.equal(expired.status, 'unpaid');
  assert.equal(left(), 10 + item.qty, 'dishes go back to stock');
  assert.match(sent.at(-1).text, /didn't receive the payment .* so it was cancelled\. Nothing was charged/s);
  assert.match(say({ type: 'reply', replyId: 'act:pay_cash' })[0].text, /don't have a UPI payment waiting/, 'cash does not revive it');

  // WhatsApp reports a payment that landed late: take the order after all.
  const r = say({ type: 'payment', from, referenceId: order.code, status: 'success', amount: order.total });
  assert.equal(orders.getOrder(order.code).status, 'placed');
  assert.equal(left(), 10, 'dishes taken again');
  assert.match(r[0].text, /is confirmed and sent to the kitchen/);
});

test('a claimed payment is never expired; only paid orders count in reports', (t) => {
  const { orders, store, say, upiOrder } = world(t);
  const { order } = upiOrder();
  say({ type: 'reply', replyId: 'act:paid' });
  assert.deepEqual(orders.expireUnpaid(new Date(LUNCH.getTime() + 60 * MIN)), [], 'staff check claimed payments');
  const a = computeAnalytics(store, { from: '2026-10-07', to: '2026-10-07' }, LUNCH);
  assert.equal(a.summary.orders, 0, 'an order waiting for payment is not a sale');
  orders.setPayment(order.code, 'paid');
  assert.equal(computeAnalytics(store, { from: '2026-10-07', to: '2026-10-07' }, LUNCH).summary.orders, 1);
});
