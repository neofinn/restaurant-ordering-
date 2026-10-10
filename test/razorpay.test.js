'use strict';

// Payment gateway (Razorpay): payment links on /pay/<code>, signed webhooks
// that confirm orders, duplicate and wrong-amount handling, refunds.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const config = require('../src/config');
const fixture = require('./fixtures/seed');
const { createApp } = require('../src/app');
const { createRazorpayClient, validRazorpaySignature, parseRazorpayWebhook } = require('../src/razorpay');
const { PLACES } = require('./helpers');

const SECRET = 'whsec_test';

test('client: payment link request, refund request', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init.body && JSON.parse(init.body) });
    if (url.endsWith('/payment_links')) return new Response(JSON.stringify({ id: 'plink_1', short_url: 'https://rzp.io/i/abc', status: 'created' }));
    return new Response(JSON.stringify({ id: 'rfnd_1', status: 'processed', amount: 5000 }));
  };
  const rp = createRazorpayClient({ keyId: 'rzp_test_k', keySecret: 's', fetchImpl });
  const expireBy = new Date('2026-10-08T10:20:00Z');
  const link = await rp.createLink({ code: 'RCABC234', reference: 'RCABC234-2', amount: 53140, description: 'Order RCABC234', customer: { name: 'Aman Gill', phone: '+919876543210' }, expireBy, callbackUrl: 'https://o.example/track.html?code=RCABC234' });
  assert.deepEqual(link, { id: 'plink_1', url: 'https://rzp.io/i/abc', status: 'created' });
  const c = calls[0];
  assert.equal(c.url, 'https://api.razorpay.com/v1/payment_links');
  assert.equal(c.init.headers.Authorization, `Basic ${Buffer.from('rzp_test_k:s').toString('base64')}`);
  assert.equal(c.body.amount, 53140);
  assert.equal(c.body.currency, 'INR');
  assert.equal(c.body.reference_id, 'RCABC234-2');
  assert.equal(c.body.expire_by, expireBy.getTime() / 1000);
  assert.deepEqual(c.body.notes, { order: 'RCABC234' });
  assert.deepEqual(c.body.notify, { sms: false, email: false });
  assert.equal(c.body.callback_method, 'get');

  assert.deepEqual(await rp.refund('pay_9', { reason: 'cancelled' }), { id: 'rfnd_1', status: 'processed', amount: 5000 });
  assert.equal(calls[1].url, 'https://api.razorpay.com/v1/payments/pay_9/refund');
  assert.equal(calls[1].body.speed, 'normal');

  const failing = createRazorpayClient({ keyId: 'k', keySecret: 's', fetchImpl: async () => new Response(JSON.stringify({ error: { description: 'Authentication failed' } }), { status: 401 }) });
  await assert.rejects(failing.createLink({ code: 'X', reference: 'X', amount: 100, description: 'x', customer: { name: 'A', phone: '1' }, expireBy }), /401 Authentication failed/);
});

test('webhook signature and parsing', () => {
  const raw = Buffer.from(JSON.stringify({ event: 'payment_link.paid' }));
  const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  assert.equal(validRazorpaySignature(raw, sig, SECRET), true);
  assert.equal(validRazorpaySignature(raw, sig, 'other'), false);
  assert.equal(validRazorpaySignature(raw, undefined, SECRET), false);
  assert.equal(validRazorpaySignature(raw, sig, ''), false, 'no secret configured: nothing is trusted');

  const paid = parseRazorpayWebhook({
    event: 'payment_link.paid',
    payload: {
      payment_link: { entity: { id: 'plink_1', reference_id: 'RCABC234-2', notes: null, amount_paid: 53140 } },
      payment: { entity: { id: 'pay_1', amount: 53140, status: 'captured', method: 'upi' } },
    },
  });
  assert.deepEqual(paid, { kind: 'paid', code: 'RCABC234', linkId: 'plink_1', paymentId: 'pay_1', amount: 53140, method: 'upi' });
  assert.equal(parseRazorpayWebhook({ event: 'payment_link.expired' }).kind, 'ignored');
});

// A running app with a fake Razorpay.
async function world(t) {
  const prev = { ...config.razorpay };
  Object.assign(config.razorpay, { keyId: 'rzp_test_k', keySecret: 's', webhookSecret: SECRET });
  t.after(() => Object.assign(config.razorpay, prev));

  const rp = { name: 'razorpay', links: [], refunds: [] };
  rp.createLink = async (args) => { rp.links.push(args); return { id: `plink_${rp.links.length}`, url: `https://rzp.io/i/${rp.links.length}`, status: 'created' }; };
  rp.refund = async (paymentId, opts) => { rp.refunds.push({ paymentId, ...opts }); return { id: `rfnd_${rp.refunds.length}`, status: 'processed' }; };
  rp.cancelLink = async () => ({});

  const sent = [];
  const waClient = { send: async (to, replies) => { sent.push(...replies); } };
  const ctx = createApp({ dbPath: ':memory:', seed: fixture, waClient, log: { info() {}, error() {}, warn() {} }, deliveryPartner: null, paymentClient: rp });
  ctx.db.exec("UPDATE outlets SET opens = '00:00', closes = '00:00'");
  const server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const order = (extra = {}) => {
    const item = ctx.orders.menuFor(null).find((i) => i.name === 'Chicken Fried Rice').id;
    return ctx.orders.createOrder({
      channel: 'whatsapp', fulfilment: 'delivery', name: 'Aman Gill', phone: '9876543210', address: 'House 12, Sector 22-B', ...PLACES.sector22,
      items: [{ id: item, qty: 2 }], paymentMethod: 'upi', ...extra,
    });
  };
  let n = 0;
  const hook = async (o, { amount = o.total, link = 'plink_1', payment = `pay_${n + 1}`, eventId = `evt_${n + 1}`, secret = SECRET } = {}) => {
    n += 1;
    const body = JSON.stringify({
      event: 'payment_link.paid',
      payload: {
        payment_link: { entity: { id: link, reference_id: o.code, notes: { order: o.code }, status: 'paid', amount_paid: amount } },
        payment: { entity: { id: payment, amount, status: 'captured', method: 'upi' } },
      },
    });
    const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
    const res = await fetch(`${base}/webhooks/razorpay`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': sig, 'X-Razorpay-Event-Id': eventId }, body });
    return { status: res.status, body: res.status === 200 ? await res.json() : null };
  };
  return { ...ctx, rp, sent, base, order, hook };
}

test('pay page: one Razorpay link per order, reused, made only when opened', async (t) => {
  const { orders, rp, base, order } = await world(t);
  const o = order();
  assert.equal(o.status, 'awaiting_payment');
  assert.equal(o.upi.link, `${config.publicBaseUrl}/pay/${o.code}`, 'QR and buttons point at our pay page');
  assert.equal(rp.links.length, 0, 'nothing is created until the customer opens it');

  const r1 = await fetch(`${base}/pay/${o.code}`, { redirect: 'manual' });
  assert.equal(r1.status, 302);
  assert.equal(r1.headers.get('location'), 'https://rzp.io/i/1');
  assert.equal(rp.links[0].amount, o.total);
  assert.equal(rp.links[0].reference, o.code);
  assert.ok(rp.links[0].expireBy - Date.now() >= 15 * 60000, 'Razorpay needs at least 15 minutes');
  const r2 = await fetch(`${base}/pay/${o.code.toLowerCase()}`, { redirect: 'manual' });
  assert.equal(r2.headers.get('location'), 'https://rzp.io/i/1', 'the same link is reused');
  assert.equal(rp.links.length, 1);

  // Once paid, the pay page just shows the order.
  orders.setPayment(o.code, 'paid');
  assert.equal((await fetch(`${base}/pay/${o.code}`, { redirect: 'manual' })).headers.get('location'), `/track.html?code=${o.code}`);
  assert.equal((await fetch(`${base}/pay/NOPE1234`, { redirect: 'manual' })).status, 404);
});

test('signed webhook confirms the order; forged or repeated ones change nothing', async (t) => {
  const { orders, base, order, hook, sent } = await world(t);
  const o = order();
  await fetch(`${base}/pay/${o.code}`, { redirect: 'manual' });

  assert.equal((await hook(o, { secret: 'forged' })).status, 401);
  assert.equal(orders.getOrder(o.code).status, 'awaiting_payment');

  const first = await hook(o, { eventId: 'evt_A', payment: 'pay_A' });
  assert.equal(first.body.result, 'paid');
  const paid = orders.getOrder(o.code);
  assert.equal(paid.status, 'placed', 'goes to the kitchen');
  assert.equal(paid.payment_status, 'paid');
  assert.match(sent.at(-1).text, /Payment of ₹[\d.,]+ received\. 🎉 Order \*\w+\* is confirmed and sent to the kitchen/);

  assert.equal((await hook(o, { eventId: 'evt_A', payment: 'pay_A' })).body.result, 'duplicate', 'Razorpay retries are ignored');
});

test('wrong amount goes to staff; a second payment and a cancelled paid order are refunded', async (t) => {
  const { orders, base, order, hook, rp, sent } = await world(t);

  const short = order();
  await fetch(`${base}/pay/${short.code}`, { redirect: 'manual' });
  assert.equal((await hook(short, { amount: 100 })).body.result, 'mismatch');
  assert.equal(orders.getOrder(short.code).payment_status, 'claimed', 'staff check it; never marked paid');
  assert.equal(orders.getOrder(short.code).status, 'awaiting_payment');

  const o = order({ phone: '9876500001' });
  await fetch(`${base}/pay/${o.code}`, { redirect: 'manual' });
  const link = 'plink_2';
  await hook(o, { link, payment: 'pay_first' });
  assert.equal((await hook(o, { link, payment: 'pay_second' })).body.result, 'refunded_extra');
  assert.deepEqual(rp.refunds.map((r) => r.paymentId), ['pay_second'], 'only the extra payment goes back');

  // The outlet cancels the paid order: the customer gets the money back.
  orders.updateStatus(o.code, 'cancelled');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(rp.refunds.map((r) => r.paymentId), ['pay_second', 'pay_first']);
  assert.equal(orders.getOrder(o.code).payment_status, 'refunded');
  assert.match(sent.at(-1).text, /refunded ₹[\d.,]+ for order/);
});

test('WhatsApp with the gateway: one self-confirming pay link, no "I\'ve paid"', async (t) => {
  const { bot, orders } = await world(t);
  const from = '919876500077';
  const say = (m) => bot.handle({ from, name: 'Neha', ...m });
  say({ type: 'text', text: '2 chilli chicken dry' });
  say({ type: 'reply', replyId: 'act:checkout' });
  say({ type: 'location', location: PLACES.phase7 });
  say({ type: 'text', text: 'Flat 3, Phase 7, near market' });
  const r = say({ type: 'reply', replyId: 'act:place_upi' });
  const o = orders.latestOrderForPhone(from);
  const pay = r.find((x) => x.type === 'buttons' && /Pay ₹/.test(x.text));
  assert.ok(pay.text.includes(`${config.publicBaseUrl}/pay/${o.code}`));
  assert.match(pay.text, /confirmed here automatically/);
  assert.deepEqual(pay.buttons.map((b) => b.id), ['act:pay_cash']);
  assert.equal(r.find((x) => x.type === 'image').url.endsWith(`/pay/${o.code}/qr.png`), true);
});

test('a refund that fails is retried by the sweep until it goes through; staff see it pending', async (t) => {
  const { orders, base, order, hook, rp, gateway } = await world(t);
  const o = order();
  await fetch(`${base}/pay/${o.code}`, { redirect: 'manual' });
  await hook(o, { payment: 'pay_R' });
  let fail = true;
  const real = rp.refund;
  rp.refund = async (...a) => { if (fail) throw new Error('gateway busy'); return real(...a); };
  orders.updateStatus(o.code, 'cancelled');
  await new Promise((r) => setImmediate(r));
  assert.equal(orders.getOrder(o.code).paymentLabel, 'Paid, refund pending');
  await gateway.sweep(new Date(Date.now() + 60000));
  assert.equal(orders.getOrder(o.code).payment_status, 'paid', 'still failing');
  fail = false;
  await gateway.sweep(new Date(Date.now() + 10 * 60000));
  assert.equal(orders.getOrder(o.code).payment_status, 'refunded');
  assert.deepEqual(rp.refunds.map((r) => r.paymentId), ['pay_R']);
});
