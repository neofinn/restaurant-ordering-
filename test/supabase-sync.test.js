'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSupabaseSync, enqueueAll, dropTriggers } = require('../src/sync/supabase');
const { createCrm } = require('../src/crm');
const { setup, LUNCH } = require('./helpers');

// A pretend Supabase REST API that keeps rows per table, like PostgREST upserts.
function fakeSupabase() {
  const tables = {};
  const calls = [];
  let down = false;
  const fetch = async (url, init) => {
    calls.push({ url, ...init });
    if (down) return { ok: false, status: 503, text: async () => 'unavailable' };
    const u = new URL(url);
    const name = u.pathname.replace('/rest/v1/', '');
    const t = (tables[name] ||= new Map());
    if (init.method === 'POST') {
      const keys = u.searchParams.get('on_conflict').split(',');
      for (const row of JSON.parse(init.body)) t.set(keys.map((k) => row[k]).join('|'), row);
    } else if (init.method === 'DELETE') {
      const key = [...u.searchParams.entries()].map(([, v]) => v.replace(/^eq\./, '')).join('|');
      t.delete(key);
    }
    return { ok: true, status: 201, text: async () => '' };
  };
  return { tables, calls, fetch, setDown: (v) => { down = v; } };
}

function world() {
  const ctx = setup();
  ctx.db.exec("UPDATE outlets SET opens = '00:00', closes = '00:00'");
  ctx.crm = createCrm({ store: ctx.store, orders: ctx.orders });
  ctx.supa = fakeSupabase();
  ctx.sync = createSupabaseSync({
    db: ctx.db, url: 'https://abc.supabase.co', serviceKey: 'service-key', fetch: ctx.supa.fetch, log: { error() {}, warn() {} },
  });
  const itemId = ctx.orders.menuFor(null).find((i) => i.name === 'Chicken Fried Rice').id;
  ctx.order = () => ctx.orders.createOrder({
    fulfilment: 'pickup', outletId: 1, name: 'Simran Kaur', phone: '9876500000', items: [{ id: itemId, qty: 2 }],
  }, LUNCH);
  return ctx;
}

test('new orders, status changes and loyalty points reach Supabase', async () => {
  const w = world();
  const o = w.order();
  for (const s of ['accepted', 'preparing', 'ready', 'completed']) w.orders.updateStatus(o.code, s);
  const r = await w.sync.flush();
  assert.ok(r.ok);
  const { tables, calls } = w.supa;
  const order = [...tables.orders.values()][0];
  assert.equal(order.code, o.code);
  assert.equal(order.status, 'completed', 'repeated changes collapse into the latest row');
  assert.equal(tables.order_items.size, 1);
  assert.ok([...tables.order_items.values()][0].line_id > 0);
  assert.equal(tables.order_events.size, 5);
  assert.equal(tables.customers.get('+919876500000').marketing_opt_in, false, 'booleans sent as booleans');
  assert.equal([...tables.loyalty_ledger.values()][0].kind, 'earn');
  assert.equal(calls[0].headers.Authorization, 'Bearer service-key');
  assert.match(calls[0].headers.Prefer, /merge-duplicates/);
  assert.equal(w.sync.status().pending, 0);
});

test('deleted rows are deleted in Supabase too', async () => {
  const w = world();
  w.db.exec('INSERT INTO outlet_unavailable_items (outlet_id, item_id) VALUES (1, 3)');
  await w.sync.flush();
  assert.equal(w.supa.tables.outlet_unavailable_items.size, 1);
  w.db.exec('DELETE FROM outlet_unavailable_items WHERE outlet_id = 1 AND item_id = 3');
  await w.sync.flush();
  assert.equal(w.supa.tables.outlet_unavailable_items.size, 0);
});

test('when Supabase is down nothing is lost; it catches up later', async () => {
  const w = world();
  w.supa.setDown(true);
  w.order();
  const r = await w.sync.flush();
  assert.equal(r.ok, false);
  assert.ok(w.sync.status().pending > 0);
  assert.equal(w.sync.status().failures, 1);
  assert.equal((await w.sync.flush()).waiting, true, 'backs off before retrying');
  w.supa.setDown(false);
  // A fresh sync (e.g. after a restart) skips the backoff wait.
  const retry = createSupabaseSync({ db: w.db, url: 'https://abc.supabase.co', serviceKey: 'k', fetch: w.supa.fetch });
  assert.ok((await retry.flush()).ok);
  assert.equal(w.supa.tables.orders.size, 1);
  assert.equal(retry.status().pending, 0);
});

test('backfill queues every existing row', async () => {
  const w = world();
  w.order();
  await w.sync.flush();
  assert.equal(w.supa.tables.outlets, undefined, 'outlets untouched so far');
  const n = enqueueAll(w.db);
  assert.ok(n > 40, `queued ${n}`);
  await w.sync.flush();
  assert.equal(w.supa.tables.outlets.size, w.orders.listOutlets().length);
  assert.ok(w.supa.tables.menu_items.size > 20);
});

test('without Supabase settings no outbox builds up', () => {
  const w = setup();
  dropTriggers(w.db);
  w.db.exec('CREATE TABLE IF NOT EXISTS sync_outbox (id INTEGER PRIMARY KEY, tbl TEXT, key TEXT, op TEXT)');
  w.db.exec("UPDATE outlets SET opens = '00:00'");
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, 0);
});
