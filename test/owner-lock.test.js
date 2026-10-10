'use strict';

// Owner PIN in front of Head office → Connections.

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const fixture = require('./fixtures/seed');
const { createApp } = require('../src/app');
const { createOwnerLock, checkPin } = require('../src/owner-lock');
const { openDb } = require('../src/db');
const { createSqliteStore } = require('../src/store/sqlite');

test('PIN rules: 6–8 digits, not repeated or a straight run', () => {
  assert.equal(checkPin('482915'), null);
  assert.equal(checkPin('20481357'), null);
  assert.match(checkPin('1234'), /6 to 8 digits/);
  assert.match(checkPin('111111'), /repeated/);
  assert.match(checkPin('123456'), /sequence/);
  assert.match(checkPin('987654'), /sequence/);
  assert.match(checkPin('12a456'), /6 to 8 digits/);
});

test('stored as a hash; wrong PINs lock it out; unlock expires when idle', () => {
  let now = Date.parse('2026-10-10T10:00:00Z');
  const store = createSqliteStore(openDb(':memory:', { seed: fixture }));
  const lock = createOwnerLock({ store, idleMinutes: 10, clock: () => now });
  assert.throws(() => lock.unlock('482915'), /No owner PIN is set yet/);
  lock.setPin('482915');
  assert.doesNotMatch(JSON.stringify(store.allSettings()), /482915/, 'only a hash is stored');

  const { token } = lock.unlock('482915');
  assert.equal(lock.check(token), true);
  now += 9 * 60000;
  assert.equal(lock.check(token), true, 'using it keeps it alive');
  now += 11 * 60000;
  assert.equal(lock.check(token), false, 'expired after 10 idle minutes');

  for (let i = 0; i < 4; i++) assert.throws(() => lock.unlock('000001'), /Wrong PIN\. \d tries left/);
  assert.throws(() => lock.unlock('000001'), /Locked for 15 min/);
  assert.throws(() => lock.unlock('482915'), /Too many wrong PINs/, 'even the right PIN waits');
  now += 16 * 60000;
  assert.ok(lock.unlock('482915').token);
  assert.ok(store.settingsLog(10).some((l) => /wrong PIN entered/.test(l.change)));

  assert.throws(() => lock.changePin('000000', '739182'), /current PIN is wrong/);
  const t2 = lock.unlock('482915').token;
  lock.changePin('482915', '739182');
  assert.equal(lock.check(t2), false, 'changing the PIN signs everyone out');
  const t3 = lock.unlock('739182').token;
  // The PIN reset on the server (another process) also signs this browser out.
  createOwnerLock({ store }).setPin('582047', 'server');
  assert.equal(lock.check(t3), false);
});

test('the Connections API is locked without the owner PIN, even for head office', async (t) => {
  const ctx = createApp({ dbPath: ':memory:', seed: fixture, log: { info() {}, error() {}, warn() {} }, waClient: { send: async () => {} } });
  const server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, owner = '') => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.adminToken}`, 'X-Owner-Unlock': owner }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  assert.equal((await call('GET', '/api/admin/owner/status')).body.hasPin, false);
  assert.equal((await call('POST', '/api/admin/owner/unlock', { pin: '482915' })).status, 423, 'no PIN set yet: nobody gets in from the panel');
  ctx.ownerLock.setPin('482915');

  for (const [m, p, b] of [['GET', '/api/admin/connections'], ['PUT', '/api/admin/connections/razorpay', { values: { 'razorpay.keyId': 'rzp_test_A1' } }], ['POST', '/api/admin/connections/razorpay/test']]) {
    const r = await call(m, p, b);
    assert.equal(r.status, 423, `${m} ${p} locked`);
    assert.equal(r.body.locked, true);
  }
  assert.equal(config.razorpay.keyId === 'rzp_test_A1', false, 'nothing was saved');

  const wrong = await call('POST', '/api/admin/owner/unlock', { pin: '111222' });
  assert.equal(wrong.status, 423);
  assert.match(wrong.body.error, /Wrong PIN/);
  const { token } = (await call('POST', '/api/admin/owner/unlock', { pin: '482915' })).body;
  assert.equal((await call('GET', '/api/admin/connections', null, token)).status, 200);
  assert.equal((await call('GET', '/api/admin/owner/status', null, token)).body.unlocked, true);
  await call('POST', '/api/admin/owner/lock', null, token);
  assert.equal((await call('GET', '/api/admin/connections', null, token)).status, 423, 'locked again');
});
