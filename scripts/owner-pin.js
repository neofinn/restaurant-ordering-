'use strict';

// Set the owner PIN that guards Head office → Connections (payment gateways,
// UPI, WhatsApp, delivery partner keys). Only someone with access to the
// server can do this, so head office staff can't set it for themselves.
//
//   npm run owner-pin              make a random 6-digit PIN and print it
//   npm run owner-pin -- 482915    use this PIN (6–8 digits)
//
// Setting a PIN signs out every browser that had Connections unlocked.

const crypto = require('node:crypto');
const config = require('../src/config');
const { openDb } = require('../src/db');
const { createSqliteStore } = require('../src/store/sqlite');
const { createOwnerLock, checkPin } = require('../src/owner-lock');

let pin = process.argv[2];
if (!pin) {
  do pin = String(crypto.randomInt(100000, 1000000)); while (checkPin(pin));
}
const bad = checkPin(pin);
if (bad) { console.error(bad); process.exit(1); }

const db = openDb(config.dbPath);
createOwnerLock({ store: createSqliteStore(db) }).setPin(pin, 'server');
db.close();
console.log(`Owner PIN for Head office → Connections: ${pin}`);
console.log('Keep it with the owner only. A running server picks it up straight away.');
