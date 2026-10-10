'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { haversineKm, isOpen, assignOutlet } = require('../src/geo');
const { setup, LUNCH, NIGHT, PLACES } = require('./helpers');

test('haversine distance is about right for a known pair', () => {
  // Sector 17 Chandigarh to Phase 7 Mohali is roughly 6.4 km as the crow flies.
  const d = haversineKm({ lat: 30.7410, lng: 76.7790 }, { lat: 30.7085, lng: 76.7195 });
  assert.ok(d > 6 && d < 7, `got ${d}`);
});

test('isOpen respects hours in IST, including past-midnight closing and 24h', () => {
  const o = { active: 1, accepting_orders: 1, opens: '11:00', closes: '23:00' };
  assert.equal(isOpen(o, LUNCH), true);
  assert.equal(isOpen(o, NIGHT), false);
  assert.equal(isOpen({ ...o, opens: '18:00', closes: '04:00' }, NIGHT), true);
  assert.equal(isOpen({ ...o, opens: '18:00', closes: '04:00' }, LUNCH), false);
  assert.equal(isOpen({ ...o, opens: '00:00', closes: '00:00' }, NIGHT), true);
  assert.equal(isOpen({ ...o, accepting_orders: 0 }, LUNCH), false);
});

test('delivery is assigned to the nearest outlet in range', () => {
  const { orders } = setup();
  const outlets = orders.listOutlets();
  assert.equal(assignOutlet(outlets, PLACES.sector22, { now: LUNCH }).outlet.slug, 'sec-17-chd');
  assert.equal(assignOutlet(outlets, PLACES.phase7, { now: LUNCH }).outlet.slug, 'phase-7-mohali');
  assert.equal(assignOutlet(outlets, PLACES.panchkula5, { now: LUNCH }).outlet.slug, 'sec-11-pkl');
});

test('falls back to the next nearest open outlet when the nearest stops taking orders', () => {
  const { db, orders } = setup();
  db.prepare("UPDATE outlets SET accepting_orders = 0 WHERE slug = 'sec-17-chd'").run();
  const a = assignOutlet(orders.listOutlets(), PLACES.sector22, { now: LUNCH });
  assert.ok(a.outlet);
  assert.notEqual(a.outlet.slug, 'sec-17-chd');
  assert.ok(a.distanceKm <= a.outlet.delivery_radius_km);
});

test('out-of-range locations get no delivery outlet but a pickup suggestion', () => {
  const { orders } = setup();
  const a = assignOutlet(orders.listOutlets(), PLACES.ludhiana, { now: LUNCH });
  assert.equal(a.outlet, null);
  assert.equal(a.reason, 'out_of_range');
  assert.ok(a.pickupSuggestion.outlet);
});

test('closed outlets are reported as closed', () => {
  const { orders } = setup();
  const a = assignOutlet(orders.listOutlets(), PLACES.sector22, { now: NIGHT });
  assert.equal(a.outlet, null);
  assert.equal(a.reason, 'closed');
  assert.equal(a.pickupSuggestion, null);
});

test('outlet location from a pasted Google Maps link or "lat, lng"', () => {
  const { coordsFromMapsLink } = require('../src/outlet-admin');
  assert.deepEqual(coordsFromMapsLink('https://www.google.com/maps/place/X/@30.7527,76.7711,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d30.75266!4d76.77114'), { lat: 30.75266, lng: 76.77114 });
  assert.deepEqual(coordsFromMapsLink('https://maps.google.com/?q=30.71998,76.7656'), { lat: 30.71998, lng: 76.7656 });
  assert.deepEqual(coordsFromMapsLink(' 30.70053, 76.76582 '), { lat: 30.70053, lng: 76.76582 });
  assert.equal(coordsFromMapsLink('https://maps.app.goo.gl/abc123'), null);
});
