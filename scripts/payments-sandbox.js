'use strict';

// Runs the real payment flow against the gateways' TEST systems (no real money):
//
//   npm run payments:sandbox                 PhonePe sandbox (shared test merchant)
//   RAZORPAY_KEY_ID=rzp_test_… RAZORPAY_KEY_SECRET=… npm run payments:sandbox
//                                            also Razorpay test mode
//
// PhonePe: place an order -> our server asks PhonePe for the order's dynamic
// UPI QR -> PhonePe's payment simulator marks it paid -> our status check finds
// the payment and sends the order to the kitchen -> the outlet cancels -> the
// refund goes through PhonePe. Then the same with a failed payment.
// The webhook can't reach a laptop or test machine; on the server it arrives
// at /webhooks/phonepe and the status check is the safety net tested here.

process.env.NODE_ENV = 'test';
const config = require('../src/config');
const jsQR = require('jsqr');
const { PNG } = require('pngjs');

// PhonePe's shared sandbox merchant (from PhonePe's developer docs).
const PHONEPE_TEST = { merchantId: 'PGTESTPAYUAT86', saltKey: '96434309-7796-489d-8924-ab56988a6076', saltIndex: '1', env: 'sandbox' };
const razorpayKeys = { keyId: process.env.RAZORPAY_KEY_ID || '', keySecret: process.env.RAZORPAY_KEY_SECRET || '' };

const fixture = require('../test/fixtures/seed');
const { createApp } = require('../src/app');
const { PLACES } = require('../test/helpers');

let failures = 0;
const check = (ok, what) => { console.log(`  ${ok ? '✓' : '✗'} ${what}`); if (!ok) failures += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startApp() {
  const sent = [];
  const ctx = createApp({
    dbPath: ':memory:', seed: fixture, deliveryPartner: null,
    waClient: { send: async (to, r) => { sent.push(...r); } },
    log: { info() {}, warn() {}, error: (...a) => console.log('    [log]', ...a) },
  });
  ctx.db.exec("UPDATE outlets SET opens = '00:00', closes = '00:00'");
  const server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const item = ctx.orders.menuFor(null).find((i) => i.name === 'Chicken Fried Rice').id;
  const order = (phone) => ctx.orders.createOrder({
    channel: 'whatsapp', fulfilment: 'delivery', name: 'Sandbox Tester', phone, address: 'House 12, Sector 22-B', ...PLACES.sector22,
    items: [{ id: item, qty: 2 }], paymentMethod: 'upi',
  });
  return { ...ctx, sent, base, order, close: () => server.close() };
}

// PhonePe's sandbox QR holds a link to its payment simulator; "pay" by posting the outcome there.
async function simulatePhonePe(pngBuffer, outcome) {
  const png = PNG.sync.read(pngBuffer);
  const url = new URL(jsQR(new Uint8ClampedArray(png.data), png.width, png.height).data);
  const res = await fetch(`https://merchant-simulator.phonepe.com/checkout/ui/v2/submit?status=${outcome}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `transactToken=${encodeURIComponent(url.searchParams.get('transactToken'))}`, redirect: 'manual',
  });
  return res.status;
}

async function phonepe() {
  console.log('\nPhonePe sandbox');
  Object.assign(config.phonepe, PHONEPE_TEST);
  const saved = { ...config.razorpay };
  Object.assign(config.razorpay, { keyId: '', keySecret: '' });
  const app = await startApp();
  try {
    check(app.gateway?.name === 'phonepe', 'gateway is PhonePe');
    const o = app.order('9811100001');
    check(o.status === 'awaiting_payment', `order ${o.code} waits for payment (₹${o.total / 100})`);

    const page = await fetch(`${app.base}/pay/${o.code}`, { redirect: 'manual' });
    check(page.status === 302 && /phonepe\.com/.test(page.headers.get('location') || ''), `pay link opens PhonePe's pay page (${(page.headers.get('location') || '').slice(0, 60)}…)`);

    const qr = await fetch(`${app.base}/pay/${o.code}/qr.png`);
    const png = Buffer.from(await qr.arrayBuffer());
    const fromPhonePe = app.store.paymentLinks(o.id).some((l) => l.kind === 'qr');
    check(qr.ok && png.subarray(1, 4).toString() === 'PNG' && fromPhonePe, `order QR is PhonePe's dynamic UPI QR (${png.length} bytes)`);

    check(await simulatePhonePe(png, 'SUCCESS') === 200, 'customer pays (PhonePe simulator: SUCCESS)');
    let confirmed = 0;
    for (let i = 0; i < 10 && !confirmed; i++) { await sleep(2000); confirmed = await app.gateway.sweep(); }
    const paid = app.orders.getOrder(o.code);
    check(paid.payment_status === 'paid' && paid.status === 'placed', `status check confirmed it: ${paid.statusLabel}, ${paid.paymentLabel}`);
    check(/confirmed and sent to the kitchen/.test(app.sent.map((m) => m.text).join('\n')), 'customer got the WhatsApp confirmation');
    const row = app.store.paymentLinks(paid.id).find((l) => l.status === 'paid');
    check(Boolean(row?.payment_id), `PhonePe payment id recorded (${row?.payment_id})`);

    app.orders.updateStatus(o.code, 'cancelled');
    let refunded = false;
    // The sandbox sometimes says "try again in a while"; the 30-second sweep retries refunds.
    for (let i = 0; i < 20 && !refunded; i++) {
      await sleep(3000);
      refunded = app.orders.getOrder(o.code).payment_status === 'refunded';
      if (!refunded) await app.gateway.sweep(new Date(Date.now() + 60 * 60000));
    }
    check(refunded, 'outlet cancelled -> refunded through PhonePe (retried if PhonePe was busy)');

    const f = app.order('9811100002');
    const fpng = Buffer.from(await (await fetch(`${app.base}/pay/${f.code}/qr.png`)).arrayBuffer());
    await simulatePhonePe(fpng, 'FAILED');
    let failedRow = null;
    for (let i = 0; i < 10 && !failedRow; i++) { await sleep(2000); await app.gateway.sweep(); failedRow = app.store.paymentLinks(f.id).find((l) => l.status === 'failed'); }
    const still = app.orders.getOrder(f.code);
    check(Boolean(failedRow) && still.status === 'awaiting_payment' && still.payment_status === 'pending', 'failed payment: order stays waiting, nothing confirmed');
  } finally {
    app.close();
    Object.assign(config.phonepe, { merchantId: '', saltKey: '' });
    Object.assign(config.razorpay, saved);
  }
}

async function razorpay() {
  console.log('\nRazorpay test mode');
  if (!/^rzp_test_/.test(razorpayKeys.keyId) || !razorpayKeys.keySecret) {
    console.log('  – skipped: set RAZORPAY_KEY_ID=rzp_test_… and RAZORPAY_KEY_SECRET (Dashboard → Test mode → API keys)');
    return;
  }
  Object.assign(config.razorpay, razorpayKeys);
  const app = await startApp();
  try {
    const o = app.order('9811100003');
    const page = await fetch(`${app.base}/pay/${o.code}`, { redirect: 'manual' });
    const url = page.headers.get('location') || '';
    check(page.status === 302 && /rzp\.io|razorpay\.com/.test(url), `payment link created: ${url}`);
    const row = app.store.paymentLinks(o.id)[0];
    const st = await app.gateway.sweep();
    check(st === 0 && app.store.paymentLinks(o.id)[0].status === 'created', `status check reaches Razorpay (link ${row?.id} unpaid)`);
    console.log(`  → To finish by hand: open ${url}, pay with test UPI success@razorpay, then the webhook or status check confirms ${o.code}.`);
  } finally {
    app.close();
  }
}

(async () => {
  await phonepe();
  await razorpay();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll sandbox checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
