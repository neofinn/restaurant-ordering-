'use strict';

// Platform database: the restaurants on the platform, the money ledger (one
// row per delivered order, plus adjustments), weekly settlements, and the
// platform's own connection settings (payment gateway, riders, WhatsApp).
// Each restaurant's orders, menu, outlets and customers live in its own
// database (data/tenants/<slug>.db), exactly as on a single-restaurant install.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS restaurants (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,          -- subdomain: <slug>.<PLATFORM_DOMAIN>
  name TEXT NOT NULL,
  brand TEXT NOT NULL DEFAULT '{}',   -- brand.json fields (colours, logo words, wording)
  custom_domain TEXT UNIQUE,          -- e.g. order.spiceroute.in (optional)
  status TEXT NOT NULL DEFAULT 'active', -- active | paused (storefront closed)
  commission_pct REAL NOT NULL,       -- % of food value (items + packing)
  legal_name TEXT, gstin TEXT, fssai TEXT, pan TEXT,
  contact_name TEXT, contact_phone TEXT, email TEXT,
  bank_name TEXT, bank_account TEXT, bank_ifsc TEXT,
  route_account TEXT,                 -- Razorpay Route linked account (acc_…)
  route_status TEXT,                  -- as Razorpay last reported it
  wa_phone_number_id TEXT UNIQUE,     -- the restaurant's own WhatsApp number (optional)
  admin_token_hash TEXT NOT NULL,     -- head office login, sha256 of the token
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Money per restaurant. kind 'order': one delivered order. 'adjustment': added
-- by the platform (a refund, a penalty, a bonus) or a balance carried forward.
-- All amounts in paise. payout = what the restaurant gets for the row
-- (negative when it owes the platform, e.g. commission on a cash order).
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  kind TEXT NOT NULL,
  order_code TEXT,
  outlet TEXT,
  at TEXT NOT NULL,                   -- when delivered (or the adjustment was made)
  payment TEXT,                       -- online | cash
  collected_by TEXT,                  -- platform | restaurant: who got the customer's money
  subtotal INTEGER NOT NULL DEFAULT 0,
  packing INTEGER NOT NULL DEFAULT 0,
  gst INTEGER NOT NULL DEFAULT 0,
  delivery_fee INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  commission INTEGER NOT NULL DEFAULT 0,
  commission_gst INTEGER NOT NULL DEFAULT 0,
  pg_fee INTEGER NOT NULL DEFAULT 0,
  tds INTEGER NOT NULL DEFAULT 0,
  gst_kept INTEGER NOT NULL DEFAULT 0, -- GST on food the platform pays (section 9(5))
  payout INTEGER NOT NULL,
  terms TEXT,                         -- the rates used, JSON
  payment_id TEXT,                    -- gateway payment (Route transfers come from it)
  transfer_id TEXT,
  transfer_status TEXT,               -- held | released | reversed | failed | none
  transfer_amount INTEGER,
  transfer_error TEXT,
  settlement_id INTEGER REFERENCES settlements(id),
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_order_once ON ledger(restaurant_id, order_code) WHERE kind = 'order';
CREATE INDEX IF NOT EXISTS ledger_open ON ledger(restaurant_id, settlement_id, at);

-- One statement per restaurant per week (Monday to Sunday, IST).
CREATE TABLE IF NOT EXISTS settlements (
  id INTEGER PRIMARY KEY,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  week_start TEXT NOT NULL,           -- YYYY-MM-DD (Monday)
  week_end TEXT NOT NULL,             -- YYYY-MM-DD (Sunday)
  orders INTEGER NOT NULL,
  sales INTEGER NOT NULL,             -- what customers paid for this restaurant's orders
  food INTEGER NOT NULL,              -- items + packing
  commission INTEGER NOT NULL,
  commission_gst INTEGER NOT NULL,
  pg_fee INTEGER NOT NULL,
  tds INTEGER NOT NULL,
  cash_collected INTEGER NOT NULL,    -- cash the restaurant kept (deducted)
  adjustments INTEGER NOT NULL,
  net INTEGER NOT NULL,               -- payable to the restaurant (negative: carried forward)
  via_route INTEGER NOT NULL DEFAULT 0, -- of net, paid by releasing Route transfers
  manual INTEGER NOT NULL DEFAULT 0,  -- of net, to pay by bank transfer
  status TEXT NOT NULL,               -- ready | released | paid | carried | nothing
  reference TEXT,                     -- bank UTR for the manual part
  released_at TEXT, released_by TEXT,
  paid_at TEXT, paid_by TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (restaurant_id, week_start)
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  secret INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
CREATE TABLE IF NOT EXISTS settings_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  by TEXT,
  integration TEXT NOT NULL,
  change TEXT NOT NULL
);
`;

function openPlatformDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

/** The settings part of a store, for src/integrations.js and src/owner-lock.js. */
function settingsStore(db) {
  const q = {
    all: db.prepare('SELECT key, value, secret, updated_at, updated_by FROM app_settings'),
    set: db.prepare(`INSERT INTO app_settings (key, value, secret, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, secret = excluded.secret, updated_at = excluded.updated_at, updated_by = excluded.updated_by`),
    del: db.prepare('DELETE FROM app_settings WHERE key = ?'),
    log: db.prepare('INSERT INTO settings_log (at, by, integration, change) VALUES (?, ?, ?, ?)'),
    readLog: db.prepare('SELECT at, by, integration, change FROM settings_log ORDER BY id DESC LIMIT ?'),
  };
  return {
    allSettings: () => q.all.all(),
    setSetting: (key, value, secret, ts, by) => q.set.run(key, value, secret ? 1 : 0, ts, by || null),
    deleteSetting: (key) => q.del.run(key),
    addSettingsLog: (at, by, integration, change) => q.log.run(at, by || null, integration, change),
    settingsLog: (n = 20) => q.readLog.all(n),
  };
}

module.exports = { openPlatformDb, settingsStore };
