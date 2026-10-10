'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { client, brand } = require('./brand');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS outlets (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  address TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  phone TEXT NOT NULL,
  delivery_radius_km REAL NOT NULL DEFAULT 5,
  upi_id TEXT,
  upi_name TEXT,
  sfx_store_code TEXT, -- Shadowfax store code, assigned at Shadowfax onboarding
  wa_payment_config TEXT, -- WhatsApp payment configuration name (Meta Business Suite)
  opens TEXT NOT NULL DEFAULT '11:00',
  closes TEXT NOT NULL DEFAULT '23:00',
  accepting_orders INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL,
  veg INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

-- Per-outlet stock-outs. A row means the item is unavailable at that outlet.
CREATE TABLE IF NOT EXISTS outlet_unavailable_items (
  outlet_id INTEGER NOT NULL REFERENCES outlets(id),
  item_id INTEGER NOT NULL REFERENCES menu_items(id),
  PRIMARY KEY (outlet_id, item_id)
);

-- Stock counts set by head office. A row means the outlet has only this many
-- left (orders take from it, cancellations put it back); no row = no limit.
CREATE TABLE IF NOT EXISTS outlet_stock (
  outlet_id INTEGER NOT NULL REFERENCES outlets(id),
  item_id INTEGER NOT NULL REFERENCES menu_items(id),
  remaining INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (outlet_id, item_id)
);

-- Outlet panel logins: one PIN per outlet, set by head office.
CREATE TABLE IF NOT EXISTS outlet_logins (
  outlet_id INTEGER PRIMARY KEY REFERENCES outlets(id),
  pin_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS staff_sessions (
  token_hash TEXT PRIMARY KEY,
  outlet_id INTEGER NOT NULL REFERENCES outlets(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS localities (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  outlet_id INTEGER NOT NULL REFERENCES outlets(id),
  channel TEXT NOT NULL,
  fulfilment TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT,
  lat REAL,
  lng REAL,
  distance_km REAL,
  notes TEXT,
  subtotal INTEGER NOT NULL,
  packing INTEGER NOT NULL,
  gst INTEGER NOT NULL,
  delivery_fee INTEGER NOT NULL,
  total INTEGER NOT NULL,
  payment_method TEXT NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'cod',
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_outlet_status ON orders(outlet_id, status);
CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS orders_phone ON orders(phone, created_at);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS order_items (
  order_id INTEGER NOT NULL REFERENCES orders(id),
  item_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  price INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS wa_sessions (
  phone TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Delivery partner bookings (Shadowfax) for delivery orders.
CREATE TABLE IF NOT EXISTS deliveries (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id),
  provider TEXT NOT NULL,
  ref TEXT,
  status TEXT NOT NULL,
  rider_name TEXT,
  rider_phone TEXT,
  rider_lat REAL,
  rider_lng REAL,
  track_url TEXT,
  error TEXT,
  price INTEGER, -- what the partner quoted (paise)
  booked_at TEXT,
  allotted_at TEXT, -- when a rider was assigned (partner speed history)
  tried TEXT, -- JSON list of partners already tried for this order
  quotes TEXT, -- JSON of the last comparison, for the dashboard
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deliveries_ref ON deliveries(ref);

-- Conversations handed over from the bot to outlet staff.
CREATE TABLE IF NOT EXISTS wa_handoffs (
  id INTEGER PRIMARY KEY,
  phone TEXT NOT NULL,
  name TEXT,
  outlet_id INTEGER REFERENCES outlets(id),
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wa_handoffs_phone ON wa_handoffs(phone, status);

CREATE TABLE IF NOT EXISTS wa_handoff_messages (
  id INTEGER PRIMARY KEY,
  handoff_id INTEGER NOT NULL REFERENCES wa_handoffs(id),
  direction TEXT NOT NULL, -- 'in' from customer, 'out' from staff, 'bot' context
  body TEXT NOT NULL,
  at TEXT NOT NULL
);

-- Every status change with its time, for rush and speed reports.
CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  status TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS order_events_order ON order_events(order_id);

-- CRM: one row per customer (by phone), saved automatically from every order.
CREATE TABLE IF NOT EXISTS customers (
  phone TEXT PRIMARY KEY,
  name TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  first_channel TEXT,
  last_address TEXT,
  last_lat REAL,
  last_lng REAL,
  last_outlet_id INTEGER,
  marketing_opt_in INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT ''
);

-- Loyalty points: earned on completed orders, redeemed or adjusted by staff.
CREATE TABLE IF NOT EXISTS loyalty_ledger (
  id INTEGER PRIMARY KEY,
  phone TEXT NOT NULL,
  order_id INTEGER,
  points INTEGER NOT NULL,
  kind TEXT NOT NULL, -- earn | redeem | adjust
  note TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS loyalty_phone ON loyalty_ledger(phone);
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_earn_once ON loyalty_ledger(order_id) WHERE kind = 'earn';

-- Star ratings collected on WhatsApp after delivery. item_id 0 = the whole order.
CREATE TABLE IF NOT EXISTS ratings (
  order_id INTEGER NOT NULL REFERENCES orders(id),
  item_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  stars INTEGER NOT NULL,
  outlet_id INTEGER NOT NULL,
  phone TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (order_id, item_id)
);
CREATE TABLE IF NOT EXISTS review_comments (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id),
  comment TEXT NOT NULL,
  at TEXT NOT NULL
);

-- Jobs to run later (e.g. ask for a review 30 minutes after delivery).
CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id INTEGER PRIMARY KEY,
  run_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  done_at TEXT
);
CREATE INDEX IF NOT EXISTS scheduled_jobs_due ON scheduled_jobs(done_at, run_at);

-- Menu price changes, so a bulk change can be undone.
CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY,
  batch TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  old_price INTEGER NOT NULL,
  new_price INTEGER NOT NULL,
  note TEXT,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wa_processed (
  message_id TEXT PRIMARY KEY,
  at TEXT NOT NULL
);

-- Payment gateway (Razorpay): one payment link per attempt to pay an order.
CREATE TABLE IF NOT EXISTS payment_links (
  id TEXT PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  provider TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'link',
  url TEXT NOT NULL,
  amount INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL,
  payment_id TEXT,
  refund_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payment_links_order ON payment_links(order_id);

-- Connection settings entered in Head office → Connections (override .env).
-- Secret values are encrypted (AES-256-GCM, key from SETTINGS_KEY).
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  secret INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
-- Who changed which connection when (never the values).
CREATE TABLE IF NOT EXISTS settings_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  by TEXT,
  integration TEXT NOT NULL,
  change TEXT NOT NULL
);

-- Gateway webhook deliveries already handled (they can arrive more than once).
CREATE TABLE IF NOT EXISTS gateway_events (
  event_id TEXT PRIMARY KEY,
  at TEXT NOT NULL
);
`;

function openDb(file, { seed = client() } = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db, seed);
  seedIfEmpty(db, seed);
  return db;
}

// Additive migrations for databases created by earlier versions.
function migrate(db, seed) {
  const cols = db.prepare('PRAGMA table_info(order_items)').all().map((c) => c.name);
  if (!cols.includes('note')) db.exec('ALTER TABLE order_items ADD COLUMN note TEXT');
  const outletCols = db.prepare('PRAGMA table_info(outlets)').all().map((c) => c.name);
  if (!outletCols.includes('upi_id')) {
    db.exec('ALTER TABLE outlets ADD COLUMN upi_id TEXT; ALTER TABLE outlets ADD COLUMN upi_name TEXT;');
    const set = db.prepare('UPDATE outlets SET upi_id = ?, upi_name = ? WHERE slug = ?');
    for (const o of seed.outlets) set.run(o.upiId || null, brand().name, o.slug);
  }
  if (!db.prepare('PRAGMA table_info(outlets)').all().some((c) => c.name === 'sfx_store_code')) {
    db.exec('ALTER TABLE outlets ADD COLUMN sfx_store_code TEXT');
  }
  if (!db.prepare('PRAGMA table_info(outlets)').all().some((c) => c.name === 'wa_payment_config')) {
    db.exec('ALTER TABLE outlets ADD COLUMN wa_payment_config TEXT');
    const set = db.prepare('UPDATE outlets SET wa_payment_config = ? WHERE slug = ?');
    for (const o of seed.outlets) set.run(o.waPaymentConfig || null, o.slug);
  }
  const deliveryCols = db.prepare('PRAGMA table_info(deliveries)').all().map((c) => c.name);
  for (const [col, type] of [['price', 'INTEGER'], ['booked_at', 'TEXT'], ['allotted_at', 'TEXT'], ['tried', 'TEXT'], ['quotes', 'TEXT']]) {
    if (!deliveryCols.includes(col)) db.exec(`ALTER TABLE deliveries ADD COLUMN ${col} ${type}`);
  }
  const linkCols = db.prepare('PRAGMA table_info(payment_links)').all().map((c) => c.name);
  if (!linkCols.includes('kind')) db.exec("ALTER TABLE payment_links ADD COLUMN kind TEXT NOT NULL DEFAULT 'link'");
  const orderCols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  if (!orderCols.includes('payment_status')) db.exec("ALTER TABLE orders ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'cod'");
}

function seedIfEmpty(db, seed) {
  if (db.prepare('SELECT COUNT(*) AS n FROM outlets').get().n > 0) return;
  db.exec('BEGIN');
  try {
    const o = db.prepare(`INSERT INTO outlets
      (slug, name, city, address, lat, lng, phone, delivery_radius_km, opens, closes, upi_id, upi_name, wa_payment_config)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const x of seed.outlets) {
      o.run(x.slug, x.name, x.city, x.address, x.lat, x.lng, x.phone, x.radiusKm, x.opens, x.closes, x.upiId || null, brand().name, x.waPaymentConfig || null);
    }
    const m = db.prepare(`INSERT INTO menu_items (category, name, description, price, veg, sort)
      VALUES (?, ?, ?, ?, ?, ?)`);
    seed.menu.forEach((x, i) => m.run(x.category, x.name, x.description || '', x.price * 100, x.veg ? 1 : 0, i));
    const l = db.prepare('INSERT INTO localities (name, city, lat, lng) VALUES (?, ?, ?, ?)');
    for (const x of seed.localities) l.run(x.name, x.city, x.lat, x.lng);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { openDb };
