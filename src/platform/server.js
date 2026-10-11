'use strict';

// Platform server: npm run platform. See src/platform/app.js.

const config = require('../config');
const { createPlatform } = require('./app');
const { weekOf, weekRange } = require('./settlement');

const P = config.platform;
if (config.production) {
  const problems = [];
  if (!P.domain) problems.push('PLATFORM_DOMAIN (e.g. order.example.com; restaurants get <name>.order.example.com)');
  if (!P.adminToken || P.adminToken === 'change-me' || P.adminToken.length < 24) problems.push('PLATFORM_ADMIN_TOKEN (24+ random characters)');
  if (!config.settingsKey) problems.push('SETTINGS_KEY (encrypts the keys saved in Connections)');
  if (!/^https:\/\//.test(config.publicBaseUrl)) problems.push('PUBLIC_BASE_URL must be https://');
  if (problems.length) {
    console.error(`Refusing to start in production. Set in .env:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
}

const platform = createPlatform();
const { app, tenants, registry, settlements } = platform;
// Background work for every restaurant: rider reassignment, review requests,
// payment status checks, expiring unpaid orders, ledger catch-up.
tenants.startBackground(1000);

// Weekly statements: from Monday 06:00 IST, last week is closed automatically
// (orders delivered after that go into next week's). Releasing money stays a
// click in Platform admin → Weekly payouts.
async function autoClose(now = new Date()) {
  const lastWeek = weekOf(new Date(Date.parse(weekRange(weekOf(now)).from) - 1));
  if (now.getTime() - Date.parse(weekRange(lastWeek).to) < 6 * 3600000) return;
  if (settlements.weeks().some((w) => w.week_start === lastWeek)) return;
  for (const t of tenants.all()) await tenants.backfill(t);
  const made = settlements.closeWeek(lastWeek, now);
  if (made.length) console.log(`[settlement] week of ${lastWeek} closed: ${made.length} statements`);
}
const closer = P.autoClose ? setInterval(() => autoClose().catch((e) => console.error('[settlement] auto close failed', e.message)), 15 * 60000) : null;

const server = app.listen(config.port, () => {
  const base = new URL(config.publicBaseUrl);
  const host = P.domain || base.hostname;
  console.log(`${P.name} platform running on http://localhost:${config.port} (${registry.list().length} restaurants)`);
  console.log(`  Marketplace:     ${config.publicBaseUrl}/`);
  console.log(`  Platform admin:  ${config.publicBaseUrl}/platform/`);
  console.log(`  Restaurants:     ${base.protocol}//<name>.${host}${base.port ? `:${base.port}` : ''}/ (or their own domain)`);
  console.log(`  Webhooks:        ${config.publicBaseUrl}/webhooks/{razorpay,whatsapp,shadowfax,porter,borzo}`);
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: shutting down`);
  const force = setTimeout(() => process.exit(1), 10000);
  force.unref();
  clearInterval(closer);
  await new Promise((r) => server.close(r));
  platform.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
