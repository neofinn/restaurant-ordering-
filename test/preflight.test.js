'use strict';

// Go-live checks, health check, and the simulator staying off in production.

const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/seed');
const config = require('../src/config');
const { preflight } = require('../src/preflight');
const { createApp } = require('../src/app');
const { setup } = require('./helpers');

const good = () => ({
  ...config,
  production: true,
  adminToken: 'a'.repeat(48),
  publicBaseUrl: 'https://order.example.in',
  whatsapp: { ...config.whatsapp, token: 't', phoneNumberId: '1', appSecret: 's', verifyToken: 'mine' },
  shadowfax: { ...config.shadowfax, mode: 'live', token: 't', baseUrl: 'https://live.shadowfax.example', callbackToken: 'c' },
  porter: { ...config.porter, apiKey: '' },
  borzo: { ...config.borzo, token: '' },
});

test('production settings: unsafe ones are errors, placeholders are warnings', () => {
  const { store } = setup();
  assert.deepEqual(preflight(good(), null).errors, []);

  const bad = good();
  bad.adminToken = 'short';
  bad.publicBaseUrl = 'http://order.example.in';
  bad.whatsapp = { ...bad.whatsapp, appSecret: '', verifyToken: 'whatsapp-verify' };
  bad.shadowfax = { ...bad.shadowfax, mode: 'simulate' };
  bad.borzo = { ...bad.borzo, token: 'b', callbackSecret: '' };
  const r = preflight(bad, store);
  for (const re of [/ADMIN_TOKEN is shorter/, /PUBLIC_BASE_URL/, /WHATSAPP_APP_SECRET/, /WHATSAPP_VERIFY_TOKEN/, /simulate/, /BORZO_CALLBACK_SECRET/]) {
    assert.ok(r.errors.some((e) => re.test(e)), `${re} is an error`);
  }
  assert.ok(r.warnings.some((w) => /Borzo points at its test server/.test(w)));
  assert.ok(r.warnings.some((w) => /Placeholder UPI IDs.*Test Kitchen - Sector 17/.test(w)));
  assert.ok(r.warnings.some((w) => /No outlet panel PIN yet/.test(w)));
  assert.ok(preflight(good(), store).warnings.some((w) => /No Shadowfax store code/.test(w)), 'live Shadowfax needs store codes');

  // Outside production the same problems are only warnings.
  assert.deepEqual(preflight({ ...bad, production: false }, store).errors, []);
});

test('health check reports the database; the simulator page is hidden in production', async () => {
  const { app, db } = createApp({ dbPath: ':memory:', seed: fixture, log: { info() {}, error() {} }, deliveryPartner: null, enableDevTools: false });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const h = await (await fetch(`${base}/healthz`)).json();
    assert.equal(h.ok, true);
    assert.equal(typeof h.version, 'string');
    assert.equal((await fetch(`${base}/whatsapp-sim.html`)).status, 404);
    assert.equal((await fetch(`${base}/`)).status, 200);
    db.close();
    assert.equal((await fetch(`${base}/healthz`)).status, 503, 'a broken database fails the health check');
  } finally {
    server.close();
  }
});
