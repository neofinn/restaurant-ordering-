'use strict';

// Copies the ordering data into Supabase (Postgres) for Power BI, campaigns
// and other tools. SQLite stays the app's own database: orders keep flowing
// even when Supabase or the network is down.
//
// How it works: SQLite triggers write the key of every changed row into
// sync_outbox. A ticker reads the current rows for those keys and upserts
// them through Supabase's REST API (PostgREST); rows deleted in SQLite are
// deleted there too. Failed batches stay in the outbox and are retried with
// backoff. The Postgres tables are in supabase/schema.sql.

// Mirrored tables, flushed in this order. `key` columns identify a row in
// both databases; order_items has no key of its own, so its SQLite rowid is
// copied as line_id. `bools` are 0/1 in SQLite and boolean in Postgres.
const TABLES = [
  { name: 'outlets', key: ['id'], bools: ['accepting_orders', 'active'] },
  { name: 'menu_items', key: ['id'], bools: ['veg', 'active'] },
  { name: 'outlet_unavailable_items', key: ['outlet_id', 'item_id'] },
  { name: 'outlet_stock', key: ['outlet_id', 'item_id'] },
  { name: 'customers', key: ['phone'], bools: ['marketing_opt_in'] },
  { name: 'orders', key: ['id'] },
  { name: 'order_items', key: ['line_id'], rowid: 'line_id' },
  { name: 'order_events', key: ['id'] },
  { name: 'deliveries', key: ['order_id'] },
  { name: 'loyalty_ledger', key: ['id'] },
  { name: 'ratings', key: ['order_id', 'item_id'] },
  { name: 'review_comments', key: ['order_id'] },
  { name: 'price_history', key: ['id'] },
];

const OUTBOX = `
CREATE TABLE IF NOT EXISTS sync_outbox (
  id INTEGER PRIMARY KEY,
  tbl TEXT NOT NULL,
  key TEXT NOT NULL, -- JSON object of the row's key columns
  op TEXT NOT NULL -- 'upsert' | 'delete'
);
`;

function keyJson(t, ref) {
  const cols = t.key.map((c) => `'${c}', ${ref}.${c === t.rowid ? 'rowid' : c}`);
  return `json_object(${cols.join(', ')})`;
}

function installTriggers(db) {
  db.exec(OUTBOX);
  for (const t of TABLES) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS sync_${t.name}_ins AFTER INSERT ON ${t.name}
        BEGIN INSERT INTO sync_outbox (tbl, key, op) VALUES ('${t.name}', ${keyJson(t, 'NEW')}, 'upsert'); END;
      CREATE TRIGGER IF NOT EXISTS sync_${t.name}_upd AFTER UPDATE ON ${t.name}
        BEGIN INSERT INTO sync_outbox (tbl, key, op) VALUES ('${t.name}', ${keyJson(t, 'NEW')}, 'upsert'); END;
      CREATE TRIGGER IF NOT EXISTS sync_${t.name}_del AFTER DELETE ON ${t.name}
        BEGIN INSERT INTO sync_outbox (tbl, key, op) VALUES ('${t.name}', ${keyJson(t, 'OLD')}, 'delete'); END;
    `);
  }
}

// When Supabase isn't configured, no outbox should pile up.
function dropTriggers(db) {
  for (const t of TABLES) {
    for (const s of ['ins', 'upd', 'del']) db.exec(`DROP TRIGGER IF EXISTS sync_${t.name}_${s}`);
  }
}

// Queue every existing row, for the first copy into a fresh Supabase project.
function enqueueAll(db) {
  installTriggers(db);
  let n = 0;
  for (const t of TABLES) {
    n += Number(db.prepare(`INSERT INTO sync_outbox (tbl, key, op)
      SELECT '${t.name}', ${keyJson(t, 'x')}, 'upsert' FROM ${t.name} x`).run().changes);
  }
  return n;
}

function createSupabaseSync({ db, url, serviceKey, fetch = globalThis.fetch, log = console, batchSize = 500 }) {
  installTriggers(db);
  const byName = Object.fromEntries(TABLES.map((t) => [t.name, t]));
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
  const state = { failures: 0, lastError: null, lastSyncAt: null, retryAt: 0 };
  let running = null;
  let timer = null;

  function readRow(t, key) {
    const where = t.key.map((c) => `${c === t.rowid ? 'rowid' : c} = ?`).join(' AND ');
    const select = t.rowid ? `rowid AS ${t.rowid}, *` : '*';
    const row = db.prepare(`SELECT ${select} FROM ${t.name} WHERE ${where}`).get(...t.key.map((c) => key[c]));
    if (!row) return null;
    const out = { ...row };
    for (const b of t.bools || []) out[b] = !!out[b];
    return out;
  }

  async function call(method, path, body, extra = {}) {
    const res = await fetch(`${url}/rest/v1/${path}`, {
      method, headers: { ...headers, ...extra }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Supabase ${method} ${path.split('?')[0]}: ${res.status} ${text.slice(0, 200)}`);
    }
  }

  // Sends one batch from the outbox. Returns how many outbox entries it cleared.
  async function flushOnce() {
    const entries = db.prepare('SELECT * FROM sync_outbox ORDER BY id LIMIT ?').all(batchSize * 4);
    if (!entries.length) return 0;
    // Latest op per row wins; rows are read fresh, so repeats collapse into one.
    const latest = new Map();
    for (const e of entries) latest.set(`${e.tbl}|${e.key}`, e);
    for (const t of TABLES) {
      const mine = [...latest.values()].filter((e) => e.tbl === t.name);
      const upserts = [];
      const deletes = [];
      for (const e of mine) {
        const key = JSON.parse(e.key);
        const row = e.op === 'upsert' ? readRow(t, key) : null;
        if (row) upserts.push(row); else deletes.push(key);
      }
      for (let i = 0; i < upserts.length; i += batchSize) {
        await call('POST', `${t.name}?on_conflict=${t.key.join(',')}`, upserts.slice(i, i + batchSize),
          { Prefer: 'resolution=merge-duplicates,return=minimal' });
      }
      for (const key of deletes) {
        const filter = t.key.map((c) => `${c}=eq.${encodeURIComponent(key[c])}`).join('&');
        await call('DELETE', `${t.name}?${filter}`, undefined, { Prefer: 'return=minimal' });
      }
    }
    const unknown = entries.filter((e) => !byName[e.tbl]).length;
    if (unknown) log.warn(`supabase sync: skipped ${unknown} entries for unknown tables`);
    db.prepare('DELETE FROM sync_outbox WHERE id <= ?').run(entries[entries.length - 1].id);
    return entries.length;
  }

  // Flushes until the outbox is empty or a call fails. Safe to call often.
  function flush() {
    if (running) return running;
    if (Date.now() < state.retryAt) return Promise.resolve({ ok: false, waiting: true });
    running = (async () => {
      let sent = 0;
      try {
        for (let n; (n = await flushOnce()) > 0;) sent += n;
        state.failures = 0;
        state.lastError = null;
        state.lastSyncAt = new Date().toISOString();
        return { ok: true, sent };
      } catch (e) {
        state.failures += 1;
        state.lastError = e.message;
        // 5 s, 10 s, 20 s ... up to 10 minutes between retries.
        state.retryAt = Date.now() + Math.min(5000 * 2 ** (state.failures - 1), 10 * 60 * 1000);
        if (state.failures === 1 || state.failures % 10 === 0) log.error(`supabase sync failed (${state.failures}x): ${e.message}`);
        return { ok: false, sent, error: e.message };
      } finally {
        running = null;
      }
    })();
    return running;
  }

  function status() {
    const pending = db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n;
    return { enabled: true, pending, ...state };
  }

  return {
    flush,
    status,
    startTicker(intervalMs = 5000) {
      if (!timer) { timer = setInterval(() => { flush(); }, intervalMs); timer.unref?.(); }
    },
    stopTicker() { clearInterval(timer); timer = null; },
  };
}

module.exports = { createSupabaseSync, installTriggers, dropTriggers, enqueueAll, TABLES };
