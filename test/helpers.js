'use strict';

const { openDb } = require('../src/db');
const { createOrderService } = require('../src/orders');
const { createSqliteStore } = require('../src/store/sqlite');

// 2:00 pm IST, when all seeded outlets are open.
const LUNCH = new Date('2026-10-07T08:30:00Z');
// 3:00 am IST, when all seeded outlets are closed.
const NIGHT = new Date('2026-10-06T21:30:00Z');

const PLACES = {
  sector22: { lat: 30.7330, lng: 76.7720 }, // nearest: Sector 17
  phase7: { lat: 30.7085, lng: 76.7195 }, // nearest: Phase 7 Mohali
  panchkula5: { lat: 30.6940, lng: 76.8600 }, // nearest: Sector 11 Panchkula
  ludhiana: { lat: 30.9010, lng: 75.8573 }, // far outside tricity
};

const fixtureSeed = require('./fixtures/seed');

// Tests run against the fixture outlets unless a test asks for the real seed.
function setup({ seed = fixtureSeed } = {}) {
  const db = openDb(':memory:', { seed });
  const store = createSqliteStore(db);
  const orders = createOrderService(store);
  return { db, store, orders };
}

module.exports = { setup, LUNCH, NIGHT, PLACES };
