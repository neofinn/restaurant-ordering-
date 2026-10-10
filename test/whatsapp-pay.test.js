'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { createBot, createSessionStore } = require('../src/whatsapp/bot');
const { createHandoffService } = require('../src/handoff');
const { toPayload } = require('../src/whatsapp/client');
const { parseWebhook } = require('../src/whatsapp/webhook');
const { notifyOnStatusChange } = require('../src/whatsapp/notify');
const { setup, LUNCH, PLACES } = require('./helpers');

function withWhatsAppPay(t) {
  const prev = config.whatsapp.payments;
  config.whatsapp.payments = true;
  t.after(() => { config.whatsapp.payments = prev; });
}

function upiOrderOverWhatsApp() {
  const { store, orders } = setup();
  const bot = createBot({ orders, handoffs: createHandoffService(store), sessions: createSessionStore(store), baseUrl: 'https://order.example' });
  const from = '919876543210';
  const say = (m) => bot.handle({ from, name: 'Aman', ...m }, LUNCH);
  say({ type: 'text', text: '2 chilli chicken dry, 1 veg hakka noodles no onion' });
  say({ type: 'reply', replyId: 'act:checkout' });
  say({ type: 'location', location: PLACES.phase7 });
  say({ type: 'text', text: 'Flat 3, Phase 7, near market' });
  const replies = say({ type: 'reply', replyId: 'act:place_upi' });
  return { orders, say, replies, order: orders.latestOrderForPhone(from), from };
}

test('pay now sends WhatsApp "Review and pay" for the exact order plus a dynamic QR', (t) => {
  withWhatsAppPay(t);
  const { replies, order } = upiOrderOverWhatsApp();
  const od = replies.find((r) => r.type === 'order_details');
  assert.ok(od, 'order_details message sent');
  assert.equal(od.referenceId, order.code);
  assert.equal(od.paymentConfiguration, 'tk-phase-7-mohali');
  const qr = replies.find((r) => r.type === 'image');
  assert.match(qr.text, new RegExp(`Order ${order.code}`));
  assert.match(qr.url, new RegExp(`/pay/${order.code}/qr.png$`));

  const p = toPayload('919876543210', od);
  const params = p.interactive.action.parameters;
  assert.equal(p.interactive.type, 'order_details');
  assert.equal(p.interactive.action.name, 'review_and_pay');
  assert.equal(params.payment_type, 'upi');
  assert.equal(params.currency, 'INR');
  assert.equal(params.reference_id, order.code);
  // WhatsApp rejects totals that don't add up.
  const sumItems = params.order.items.reduce((s, i) => s + i.amount.value * i.quantity, 0);
  assert.equal(sumItems, params.order.subtotal.value);
  assert.equal(params.order.subtotal.value + params.order.tax.value + params.order.shipping.value, params.total_amount.value);
  assert.equal(params.total_amount.value, order.total);
  assert.match(params.order.shipping.description, /^Delivery \(/);
  assert.ok(params.order.items.some((i) => i.name === 'Veg Hakka Noodles (no onion)'));
});

test('WhatsApp payment success marks the order paid; wrong amount or someone else is not trusted', (t) => {
  withWhatsAppPay(t);
  const { orders, say, order } = upiOrderOverWhatsApp();
  assert.deepEqual(say({ type: 'payment', referenceId: order.code, status: 'pending' }), []);

  let r = say({ type: 'payment', referenceId: order.code, status: 'success', amount: order.total - 100 });
  assert.match(r[0].text, /bill is/);
  assert.equal(orders.getOrder(order.code).payment_status, 'claimed');

  r = say({ type: 'payment', referenceId: order.code, status: 'success', amount: order.total, transactionId: 'UPI123' });
  assert.match(r[0].text, /Payment of ₹[\d.,]+ received .*UPI ref UPI123/);
  assert.equal(orders.getOrder(order.code).payment_status, 'paid');
  // Duplicate confirmations are ignored.
  assert.deepEqual(say({ type: 'payment', referenceId: order.code, status: 'captured', amount: order.total }), []);
});

test('payment from a different number is ignored; failure offers retry or cash', (t) => {
  withWhatsAppPay(t);
  const { orders, say, order } = upiOrderOverWhatsApp();
  assert.deepEqual(say({ type: 'payment', from: '919999900000', referenceId: order.code, status: 'success', amount: order.total }), []);
  assert.equal(orders.getOrder(order.code).payment_status, 'pending');

  const r = say({ type: 'payment', referenceId: order.code, status: 'failed' });
  assert.match(r[0].text, /didn't go through/);
  const retry = say({ type: 'reply', replyId: 'act:pay_again' });
  assert.ok(retry.some((x) => x.type === 'order_details'));
});

test('webhook parses WhatsApp payment statuses and payment messages', () => {
  const msgs = parseWebhook({ entry: [{ changes: [{ value: {
    statuses: [
      { id: 'w1', status: 'delivered', recipient_id: '9198' },
      { id: 'w2', from: '919876543210', type: 'payment', status: 'success', payment: { reference_id: 'RCABC234', amount: { value: 35390, offset: 100 }, transaction: { id: 'T1' } } },
    ],
    messages: [{ id: 'm1', from: '919876543210', type: 'interactive', interactive: { type: 'payment', payment: { reference_id: 'RCABC234', status: 'success', transaction_id: 'T1', total_amount: { value: 35390, offset: 100 } } } }],
  } }] }] });
  assert.deepEqual(msgs.map((m) => [m.type, m.referenceId, m.status, m.amount, m.from]), [
    ['payment', 'RCABC234', 'success', 35390, '919876543210'],
    ['payment', 'RCABC234', 'success', 35390, '919876543210'],
  ]);
});

test('order status updates refresh the WhatsApp order card', (t) => {
  withWhatsAppPay(t);
  const { orders, order } = upiOrderOverWhatsApp();
  const sent = [];
  notifyOnStatusChange({ orders, client: { send: async (to, r) => { sent.push(...r); } }, log: { error() {} } });
  orders.setPayment(order.code, 'paid', new Date(), 'whatsapp');
  orders.updateStatus(order.code, 'accepted');
  assert.equal(sent[0].type, 'order_status');
  assert.equal(sent[0].status, 'processing');
  const p = toPayload('919876543210', sent[0]);
  assert.deepEqual(p.interactive.action, { name: 'review_order', parameters: { reference_id: order.code, order: { status: 'processing' } } });
});

test('without WhatsApp payments set up, pay now falls back to QR + UPI link', () => {
  const { replies } = upiOrderOverWhatsApp();
  assert.ok(!replies.some((r) => r.type === 'order_details'));
  assert.ok(replies.some((r) => r.type === 'image'));
});
