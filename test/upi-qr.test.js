'use strict';

// Dynamic UPI QR: one business-wide UPI ID (from the payment gateway), the
// exact amount and the order code in every order's QR.

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { upiFor, upiLink } = require('../src/payments');
const { canPayOnline } = require('../src/orders');
const { setup, PLACES } = require('./helpers');

function withUpi(t, upi, razorpayKey = '') {
  const prev = { upi: { ...config.upi }, key: config.razorpay.keyId };
  Object.assign(config.upi, upi);
  config.razorpay.keyId = razorpayKey;
  t.after(() => { Object.assign(config.upi, prev.upi); config.razorpay.keyId = prev.key; });
}

test('business-wide UPI ID replaces placeholders; a real outlet UPI ID still wins', (t) => {
  withUpi(t, { id: 'spiceroute@okhdfcbank', payeeName: 'Spice Route Food', merchantCode: '5812' });
  assert.deepEqual(upiFor({ upi_id: 'tk-sec-17@example', upi_name: 'X' }), { id: 'spiceroute@okhdfcbank', name: 'Spice Route Food' });
  assert.deepEqual(upiFor({ upi_id: null }), { id: 'spiceroute@okhdfcbank', name: 'Spice Route Food' });
  assert.deepEqual(upiFor({ upi_id: 'sec34@ybl', upi_name: 'Spice Route Sec 34' }), { id: 'sec34@ybl', name: 'Spice Route Sec 34' });
});

test('each order QR carries the UPI ID, exact amount, order code and merchant code', (t) => {
  withUpi(t, { id: 'spiceroute@okhdfcbank', payeeName: 'Spice Route Food', merchantCode: '5812' });
  const { orders } = setup();
  const rice = orders.menuFor(null).find((i) => i.name === 'Chicken Fried Rice').id;
  const o = orders.createOrder({
    fulfilment: 'delivery', name: 'Aman', phone: '9876543210', address: 'House 12, Sector 22-B', ...PLACES.sector22,
    items: [{ id: rice, qty: 2 }], paymentMethod: 'upi',
  }, new Date('2026-10-07T08:30:00Z'));
  const u = new URL(o.upi.link.replace('upi://pay', 'https://x/pay'));
  assert.equal(u.searchParams.get('pa'), 'spiceroute@okhdfcbank');
  assert.equal(u.searchParams.get('pn'), 'Spice Route Food');
  assert.equal(u.searchParams.get('mc'), '5812');
  assert.equal(u.searchParams.get('am'), (o.total / 100).toFixed(2));
  assert.equal(u.searchParams.get('cu'), 'INR');
  assert.equal(u.searchParams.get('tr'), o.code, 'order code is the transaction reference');
  assert.match(u.searchParams.get('tn'), new RegExp(`order ${o.code}$`));
});

test('no merchant code unless set; pay now offered only where money can go', (t) => {
  withUpi(t, { id: '', payeeName: '', merchantCode: '' });
  assert.doesNotMatch(upiLink({ upiId: 'a@b', payee: 'A', amountPaise: 100, code: 'RC1' }), /mc=/);
  assert.equal(canPayOnline({ upi_id: null }), false);
  assert.equal(canPayOnline({ upi_id: 'x@ybl' }), true);
  config.razorpay.keyId = 'rzp_test_k';
  assert.equal(canPayOnline({ upi_id: null }), true, 'the gateway takes payments for every outlet');
});
