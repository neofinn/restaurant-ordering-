'use strict';

// One-time copy of everything already in SQLite into Supabase. Run it once
// after creating the tables from supabase/schema.sql; after that the app keeps
// Supabase up to date on its own. Safe to re-run (rows are upserted).
//
//   npm run supabase:backfill

const config = require('../src/config');
const { openDb } = require('../src/db');
const { createSupabaseSync, enqueueAll } = require('../src/sync/supabase');

async function main() {
  const { url, serviceKey } = config.supabase;
  if (!url || !serviceKey) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env first.');
    process.exit(1);
  }
  const db = openDb(config.dbPath);
  console.log(`Queued ${enqueueAll(db)} rows from ${config.dbPath}`);
  const sync = createSupabaseSync({ db, url, serviceKey });
  const result = await sync.flush();
  if (!result.ok) {
    console.error(`Stopped: ${result.error}\nFix the problem and run again; nothing is lost.`);
    process.exit(1);
  }
  console.log(`Done: ${result.sent} rows sent to ${url}`);
}

main();
