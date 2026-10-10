'use strict';

// Head office → Connections: validated, encrypted, applied live, never shown back.

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const fixture = require('./fixtures/seed');
const { createApp } = require('../src/app');

const quiet = { info() {}, warn() {}, error() {} };

// Restore every connection setting after a test (config is shared).
function keepConfig(t) {
  const snap = JSON.parse(JSON.stringify({ upi: config.upi, razorpay: config.razorpay, phonepe: config.phonepe, whatsapp: config.whatsapp, shadowfax: config.shadowfax, porter: config.porter, borzo: config.borzo, payments: config.payments, settingsKey: config.settingsKey }));
  t.after(() => { for (const [k, v] of Object.entries(snap)) { if (typeof v === 'object') Object.assign(config[k], v); else config[k] = v; } });
}

async function world(t, { fetchImpl } = {}) {
  keepConfig(t);
  const ctx = createApp({ dbPath: ':memory:', seed: fixture, log: quiet, fetchImpl, waClient: { send: async () => {} } });
  const server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  // Connections need the owner PIN: set it (as the server would) and unlock.
  ctx.ownerLock.setPin('482915');
  const unlock = ctx.ownerLock.unlock('482915').token;
  const call = async (method, path, body, token = config.adminToken, owner = unlock) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Owner-Unlock': owner }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return Object.assign(ctx, { call });
}

test('only head office can see or change connections', async (t) => {
  const { call } = await world(t);
  assert.equal((await call('GET', '/api/admin/connections', null, 'wrong')).status, 401);
  assert.equal((await call('PUT', '/api/admin/connections/razorpay', { values: {} }, 'wrong')).status, 401);
  const r = await call('GET', '/api/admin/connections');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.integrations.map((c) => c.id), ['payments', 'upi', 'razorpay', 'phonepe', 'whatsapp', 'shadowfax', 'porter', 'borzo']);
  assert.match(r.body.integrations.find((c) => c.id === 'phonepe').webhook, /\/webhooks\/phonepe$/);
});

test('secrets are encrypted, never sent back, logged without values; bad input is refused', async (t) => {
  const { call, db } = await world(t);
  const bad = await call('PUT', '/api/admin/connections/razorpay', { values: { 'razorpay.keyId': 'not-a-key' } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /start rzp_live_ or rzp_test_/);
  assert.equal((await call('PUT', '/api/admin/connections/upi', { values: { 'upi.id': 'nope' } })).status, 400);

  const ok = await call('PUT', '/api/admin/connections/razorpay', { values: { 'razorpay.keyId': 'rzp_test_ABC123', 'razorpay.keySecret': 'supersecretvalue9876', 'razorpay.webhookSecret': 'whsec_42' } });
  assert.equal(ok.status, 200);
  const rp = ok.body.integrations.find((c) => c.id === 'razorpay');
  assert.deepEqual(rp.status, { state: 'test', text: 'Test mode' });
  const secret = rp.fields.find((f) => f.path === 'razorpay.keySecret');
  assert.equal(secret.value, undefined, 'the value never goes to the browser');
  assert.equal(secret.hint, 'set, ends …9876');
  assert.equal(secret.source, 'panel');
  assert.doesNotMatch(JSON.stringify(ok.body), /supersecretvalue/);

  const row = db.prepare("SELECT value, secret FROM app_settings WHERE key = 'razorpay.keySecret'").get();
  assert.equal(row.secret, 1);
  assert.match(row.value, /^v1:/);
  assert.doesNotMatch(row.value, /supersecret/, 'stored encrypted');
  assert.equal(config.razorpay.keySecret, 'supersecretvalue9876', 'in use straight away');
  assert.match(ok.body.log[0].change, /Key secret changed/);
  assert.doesNotMatch(ok.body.log[0].change, /supersecret/);
});

test('saving switches the gateway and riders live; clearing falls back to the server setting', async (t) => {
  const fetchImpl = async () => new Response('{}');
  const ctx = await world(t, { fetchImpl });
  const { call, orders, dispatcher } = ctx;
  const listeners = orders.events.listenerCount('status');
  assert.equal(ctx.gateway, null);

  await call('PUT', '/api/admin/connections/phonepe', { values: { 'phonepe.merchantId': 'PGTESTPAYUAT86', 'phonepe.saltKey': 'salt-1', 'phonepe.env': 'sandbox' } });
  assert.equal(ctx.gateway?.name, 'phonepe');
  assert.equal(orders.events.listenerCount('status'), listeners + 1);
  await call('PUT', '/api/admin/connections/payments', { values: { 'payments.provider': 'none' } });
  assert.equal(ctx.gateway, null, 'switched off from the panel');
  assert.equal(orders.events.listenerCount('status'), listeners, 'the old gateway stopped listening (no double refunds)');
  await call('PUT', '/api/admin/connections/payments', { values: { 'payments.provider': '' } });
  assert.equal(ctx.gateway?.name, 'phonepe', 'cleared back to automatic');

  assert.deepEqual(dispatcher.providers.map((p) => p.name), []);
  await call('PUT', '/api/admin/connections/porter', { values: { 'porter.apiKey': 'pk_1' } });
  assert.deepEqual(dispatcher.providers.map((p) => p.name), ['porter']);
  const back = await call('PUT', '/api/admin/connections/porter', { values: { 'porter.apiKey': '' } });
  assert.deepEqual(dispatcher.providers.map((p) => p.name), []);
  assert.equal(back.body.integrations.find((c) => c.id === 'porter').fields[0].source, 'unset');
});

test('test buttons read each service\'s answer', async (t) => {
  let answer = { status: 200, body: '{}' };
  const seen = [];
  const fetchImpl = async (url, init = {}) => { seen.push({ url, headers: init.headers }); return new Response(answer.status === 204 ? null : answer.body, { status: answer.status }); };
  const { call } = await world(t, { fetchImpl });
  const testOf = async (id) => (await call('POST', `/api/admin/connections/${id}/test`)).body;

  assert.equal((await testOf('razorpay')).ok, false, 'no keys yet');
  await call('PUT', '/api/admin/connections/razorpay', { values: { 'razorpay.keyId': 'rzp_test_A1', 'razorpay.keySecret': 's', 'razorpay.webhookSecret': 'w' } });
  assert.match((await testOf('razorpay')).message, /accepted the keys \(test mode\)/);
  assert.match(seen.at(-1).url, /\/payment_links\?count=1$/);
  answer = { status: 401, body: '{}' };
  assert.match((await testOf('razorpay')).message, /rejected/);

  await call('PUT', '/api/admin/connections/phonepe', { values: { 'phonepe.merchantId': 'M1', 'phonepe.saltKey': 'k' } });
  answer = { status: 204, body: '' };
  assert.equal((await testOf('phonepe')).ok, true);
  answer = { status: 400, body: '{"code":"KEY_NOT_CONFIGURED"}' };
  assert.match((await testOf('phonepe')).message, /doesn't know merchant M1/);

  await call('PUT', '/api/admin/connections/whatsapp', { values: { 'whatsapp.token': 'EAAG', 'whatsapp.phoneNumberId': '1234567890' } });
  answer = { status: 200, body: '{"verified_name":"Spice Route","display_phone_number":"+91 98765 43210","quality_rating":"GREEN"}' };
  assert.match((await testOf('whatsapp')).message, /Connected: Spice Route \+91 98765 43210, quality GREEN/);
  assert.equal(seen.at(-1).headers.Authorization, 'Bearer EAAG');
  assert.equal((await testOf('porter')).ok, null, 'no live check for delivery partners');
});

test('a changed SETTINGS_KEY: saved secrets are reported unreadable and the server setting is used', async (t) => {
  const ctx = await world(t);
  config.settingsKey = 'key-one';
  await ctx.call('PUT', '/api/admin/connections/razorpay', { values: { 'razorpay.keyId': 'rzp_test_A1', 'razorpay.keySecret': 'first' } });
  config.settingsKey = 'key-two';
  const d = ctx.integrations.describe();
  ctx.integrations.apply();
  assert.deepEqual(ctx.integrations.describe().unreadable, ['razorpay.keySecret']);
  assert.ok(d);
  assert.notEqual(config.razorpay.keySecret, 'first');
});
