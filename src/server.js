'use strict';

const config = require('./config');
const { createApp } = require('./app');
const { preflight, format } = require('./preflight');
const { brand } = require('./brand');

const ctx = createApp();
const { app, db, store, orders, reviews, sync, dispatcher, reports, version, payments } = ctx;

// Go-live checks: in production, refuse to start on an unsafe setting.
const report = preflight(config, store);
if (report.errors.length || report.warnings.length) console.log(`Setup check:\n${format({ ...report, ok: [] })}`);
if (config.production && report.errors.length) {
  console.error('Refusing to start in production until the ✗ items above are fixed (see .env).');
  process.exit(1);
}

// Moves bookings that get no rider in time to the next delivery partner.
dispatcher.startSweeper(60 * 1000);
// Sends review requests (30 min after delivery) and other scheduled jobs.
reviews.startTicker(60 * 1000);
// Asks the payment gateway about open payments, in case a webhook was lost.
payments.startSweeper(30 * 1000);
// Cancels "Pay now (UPI)" orders nobody paid within the payment window.
const expiry = setInterval(() => { try { orders.expireUnpaid(); } catch (e) { console.error('[orders] expiry failed', e.message); } }, 30 * 1000);
// Copies new and changed rows to Supabase every few seconds, when configured.
if (sync) sync.startTicker(5000);

const server = app.listen(config.port, () => {
  console.log(`${brand().name} ordering ${version} running on http://localhost:${config.port}`);
  console.log(`  Customer app:       ${config.publicBaseUrl}/`);
  console.log(`  Outlet panel:       ${config.publicBaseUrl}/outlet/`);
  console.log(`  Head office panel:  ${config.publicBaseUrl}/admin/`);
  if (sync) console.log(`  Supabase copy:      ${config.supabase.url}`);
  if (!config.production) console.log(`  WhatsApp simulator: ${config.publicBaseUrl}/whatsapp-sim.html`);
});

// Restarts (updates, pm2 reload) finish open requests, send what's waiting for
// Supabase, and close the database cleanly.
let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: shutting down`);
  const force = setTimeout(() => process.exit(1), 10000);
  force.unref();
  dispatcher.stopSweeper();
  clearInterval(expiry);
  payments.stopSweeper();
  reviews.stopTicker();
  if (sync) sync.stopTicker();
  await new Promise((r) => server.close(r));
  if (sync) await sync.flush().catch(() => {});
  reports.close();
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch { /* already closed */ }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
