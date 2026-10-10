'use strict';

// PhonePe gateway: request signing, callbacks, dynamic QR through our server,
// and the status check never double-counting a payment the callback also reports.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const config = require('../src/config');
const fixture = require('./fixtures/seed');
const { createApp } = require('../src/app');
const { createPhonePeClient, validPhonePeCallback, parsePhonePeCallback } = require('../src/phonepe');
const { PLACES } = require('./helpers');

const SALT = 'test-salt';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const callback = (data, code = 'PAYMENT_SUCCESS') => {
  const response = Buffer.from(JSON.stringify({ success: true, code, data })).toString('base64');
  return { body: { response }, verify: `${sha(response + SALT)}###1` };
};

test('client signs requests the PhonePe way and reads status', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/pg/v1/pay')) return new Response(JSON.stringify({ success: true, data: { instrumentResponse: { qrData: Buffer.from('PNGDATA').toString('base64') } } }));
    return new Response(JSON.stringify({ success: true, code: 'PAYMENT_SUCCESS', data: { merchantTransactionId: 'RCABC234-Q1', transactionId: 'T1', amount: 53140, state: 'COMPLETED', paymentInstrument: { utr: '123' } } }));
  };
  const pp = createPhonePeClient({ merchantId: 'M1', saltKey: SALT, callbackUrl: 'https://o.example/webhooks/phonepe', fetchImpl });
  const qr = await pp.createQr({ reference: 'RCABC234-Q1', amount: 53140, customer: { phone: '+919876543210' } });
  assert.equal(qr.id, 'RCABC234-Q1');
  assert.equal(qr.png.toString(), 'PNGDATA');
  const { request } = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].init.headers['X-VERIFY'], `${sha(`${request}/pg/v1/pay${SALT}`)}###1`);
  const payload = JSON.parse(Buffer.from(request, 'base64').toString());
  assert.deepEqual([payload.merchantId, payload.amount, payload.paymentInstrument.type, payload.mobileNumber], ['M1', 53140, 'UPI_QR', '9876543210']);

  assert.deepEqual(await pp.checkStatus('RCABC234-Q1'), { state: 'paid', paymentId: 'T1', amount: 53140, utr: '123', linkId: 'RCABC234-Q1' });
  assert.equal(calls[1].url, 'https://api-preprod.phonepe.com/apis/pg-sandbox/pg/v1/status/M1/RCABC234-Q1');
  assert.equal(calls[1].init.headers['X-VERIFY'], `${sha(`/pg/v1/status/M1/RCABC234-Q1${SALT}`)}###1`);
});

test('callbacks: signature and parsing', () => {
  const ok = callback({ merchantTransactionId: 'RCABC234-Q1', transactionId: 'T9', amount: 100, state: 'COMPLETED' });
  assert.equal(validPhonePeCallback(ok.body, ok.verify, SALT), true);
  assert.equal(validPhonePeCallback(ok.body, ok.verify, 'other'), false);
  assert.equal(validPhonePeCallback({ response: 'x' }, ok.verify, SALT), false);
  assert.deepEqual(parsePhonePeCallback(ok.body), { kind: 'paid', code: null, linkId: 'RCABC234-Q1', paymentId: 'T9', amount: 100, eventId: 'phonepe:T9' });
  assert.equal(parsePhonePeCallback(callback({ state: 'FAILED' }, 'PAYMENT_ERROR').body).kind, 'ignored');
});

async function world(t) {
  const prev = { pp: { ...config.phonepe }, rp: { ...config.razorpay } };
  Object.assign(config.phonepe, { merchantId: 'M1', saltKey: SALT, saltIndex: '1', env: 'sandbox' });
  Object.assign(config.razorpay, { keyId: '' });
  t.after(() => { Object.assign(config.phonepe, prev.pp); Object.assign(config.razorpay, prev.rp); });

  const pp = { name: 'phonepe', qrs: [], refunds: [], status: new Map() };
  pp.createLink = async (a) => ({ id: a.reference, url: `https://mercury-uat.phonepe.com/pay/${a.reference}` });
  pp.createQr = async (a) => { pp.qrs.push(a); return { id: a.reference, png: Buffer.from(`\x89PNG-${a.reference}`) }; };
  pp.checkStatus = async (id) => pp.status.get(id) || { state: 'pending' };
  pp.refund = async (paymentId, o) => { pp.refunds.push({ paymentId, ...o }); return { id: 'RF1', status: 'PENDING' }; };

  const sent = [];
  const ctx = createApp({ dbPath: ':memory:', seed: fixture, waClient: { send: async (to, r) => { sent.push(...r); } }, log: { info() {}, error() {}, warn() {} }, deliveryPartner: null, paymentClient: pp });
  ctx.db.exec("UPDATE outlets SET opens = '00:00', closes = '00:00'");
  const server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const item = ctx.orders.menuFor(null).find((i) => i.name === 'Chicken Fried Rice').id;
  const order = () => ctx.orders.createOrder({
    channel: 'whatsapp', fulfilment: 'delivery', name: 'Aman', phone: '9876543210', address: 'House 12, Sector 22-B', ...PLACES.sector22, items: [{ id: item, qty: 2 }], paymentMethod: 'upi',
  });
  const post = (cb) => fetch(`${base}/webhooks/phonepe`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-VERIFY': cb.verify }, body: JSON.stringify(cb.body) });
  return { ...ctx, pp, sent, base, order, post };
}

test('the order QR is the gateway\'s own; its callback confirms the order', async (t) => {
  const { orders, pp, base, order, post, sent } = await world(t);
  const o = order();
  const qr = await fetch(`${base}/pay/${o.code}/qr.png`);
  assert.equal(await qr.text(), `\x89PNG-${o.code}-Q1`);
  assert.equal(pp.qrs[0].amount, o.total);
  await fetch(`${base}/pay/${o.code}/qr.png`);
  assert.equal(pp.qrs.length, 1, 'the same QR is served again');

  const forged = callback({ merchantTransactionId: `${o.code}-Q1`, transactionId: 'T1', amount: o.total, state: 'COMPLETED' });
  assert.equal((await post({ ...forged, verify: 'bad###1' })).status, 401);
  const r = await post(forged);
  assert.equal((await r.json()).result, 'paid');
  assert.equal(orders.getOrder(o.code).status, 'placed');
  assert.match(sent.at(-1).text, /confirmed and sent to the kitchen/);
});

test('status check confirms when the callback is lost; a late callback for the same payment is not refunded', async (t) => {
  const { orders, pp, base, order, post, gateway } = await world(t);
  const o = order();
  await fetch(`${base}/pay/${o.code}/qr.png`);
  assert.equal(await gateway.sweep(), 0, 'nothing paid yet');
  pp.status.set(`${o.code}-Q1`, { state: 'paid', paymentId: 'T7', amount: o.total });
  assert.equal(await gateway.sweep(), 1);
  assert.equal(orders.getOrder(o.code).payment_status, 'paid');
  assert.equal(await gateway.sweep(), 0, 'already settled: not asked again');

  const late = await post(callback({ merchantTransactionId: `${o.code}-Q1`, transactionId: 'T7', amount: o.total, state: 'COMPLETED' }));
  assert.equal((await late.json()).result, 'duplicate');
  assert.deepEqual(pp.refunds, [], 'the one payment is not refunded');
});
