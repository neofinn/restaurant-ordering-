'use strict';

// Client profiles: the brand reaches pages, messages and payments, and a
// profile is picked with CLIENT.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fixture = require('./fixtures/seed');
const { brand, useClient, shortName, fullName, brandPage, withDefaults } = require('../src/brand');
const { upiLink } = require('../src/payments');
const { createApp } = require('../src/app');

test('defaults fill in what a profile leaves out', () => {
  const b = withDefaults({ name: 'Spice Route' });
  assert.deepEqual(b.logo, ['Spice', 'Route']);
  assert.equal(b.outletPrefix, 'Spice Route - ');
  assert.equal(b.menuTitle, 'SPICE ROUTE');
  assert.match(b.description, /nearest Spice Route/);
  assert.equal(withDefaults({}).name, 'Your Restaurant');
});

test('outlet names, UPI note and pages use the active brand', () => {
  useClient({ ...fixture, brand: { id: 'spice', name: 'Spice Route', colors: { brand: '#123456' } } });
  try {
    assert.equal(fullName('Sector 9'), 'Spice Route - Sector 9');
    assert.equal(fullName('Spice Route - Sector 9'), 'Spice Route - Sector 9');
    assert.equal(shortName('Spice Route - Sector 9'), 'Sector 9');
    assert.match(upiLink({ upiId: 'a@b', payee: brand().name, amountPaise: 100, code: 'X1' }), /pn=Spice%20Route.*tn=Spice%20Route%20order%20X1/);
    const html = brandPage('<html><head><title>{{name}}</title><link rel="stylesheet" href="/s.css"></head><div class="logo">{{logo}}</div></html>');
    assert.match(html, /<title>Spice Route<\/title>/);
    assert.match(html, /Spice <span>Route<\/span>/);
    assert.match(html, /--brand:#123456.*<\/head>/s);
    assert.ok(html.indexOf('s.css') < html.indexOf('--brand:#123456'), 'brand colours come after the stylesheet');
    assert.match(html, /window\.BRAND=\{"id":"spice","name":"Spice Route"/);
  } finally {
    useClient(fixture);
  }
});

test('the server sends branded pages and no client name is left in them', async () => {
  const { app } = createApp({ dbPath: ':memory:', seed: fixture, log: { info() {}, error() {} }, deliveryPartner: null });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const p of ['/', '/track.html', '/admin/', '/outlet/', '/whatsapp-sim.html']) {
      const res = await fetch(base + p);
      assert.equal(res.status, 200, p);
      const html = await res.text();
      assert.match(html, /Test Kitchen/, p);
      assert.doesNotMatch(html, /\{\{/, p);
    }
    assert.equal((await fetch(`${base}/admin`, { redirect: 'manual' })).status, 301);
    assert.match(await (await fetch(`${base}/styles.css`)).text(), /--brand/);
  } finally {
    server.close();
  }
});

test('CLIENT picks the profile folder', () => {
  const run = (client) => execFileSync(process.execPath, ['-e', "process.stdout.write(require('./src/brand').brand().name)"], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, CLIENT: client }, stdio: 'pipe',
  }).toString();
  assert.equal(run(path.join(__dirname, 'fixtures', 'profile')), 'Profile Test');
  assert.throws(() => run('no-such-client'), /Client profile not found/);
});
