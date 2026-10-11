'use strict';

// One running copy of the ordering app per restaurant, each with its own
// database (orders, menu, outlets, customers, staff logins), branding and web
// address. They share the process, the platform's payment gateway, delivery
// partner accounts and WhatsApp business account. Everything a restaurant's
// code does (requests, timers, events) runs inside its context, so brand() and
// config.publicBaseUrl answer for that restaurant (src/tenant-context.js).

const crypto = require('node:crypto');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const config = require('../config');
const tenantContext = require('../tenant-context');
const { withDefaults } = require('../brand');
const { createApp } = require('../app');
const { createClient } = require('../whatsapp/client');
const { ValidationError } = require('../orders');

const als = new AsyncLocalStorage();
tenantContext.setProvider(() => als.getStore() || null);

const sameToken = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Check the first outlet given at onboarding; returns a seed outlet. */
function seedOutlet(o = {}, brand) {
  const errors = [];
  const area = String(o.area || o.name || '').trim();
  const lat = Number(o.lat);
  const lng = Number(o.lng);
  if (!area) errors.push('Outlet: enter its area or name (e.g. Malviya Nagar).');
  if (!String(o.address || '').trim()) errors.push('Outlet: enter the address.');
  if (!String(o.city || '').trim()) errors.push('Outlet: enter the city.');
  if (!(lat >= 6 && lat <= 37.5 && lng >= 68 && lng <= 97.5)) errors.push('Outlet: map point (latitude, longitude) must be in India. Copy it from Google Maps.');
  if (!/^\+?\d{10,13}$/.test(String(o.phone || '').replace(/[\s-]/g, ''))) errors.push('Outlet: phone should be 10 digits.');
  const opens = o.opens || '11:00';
  const closes = o.closes || '23:00';
  if (!HHMM.test(opens) || !HHMM.test(closes)) errors.push('Outlet: hours are HH:MM, like 11:00 and 23:00.');
  if (errors.length) throw new ValidationError(errors.join(' '), 'invalid');
  const b = withDefaults(brand);
  return {
    slug: area.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'outlet-1',
    name: `${b.outletPrefix}${area}`, city: String(o.city).trim(), address: String(o.address).trim(), lat, lng,
    phone: String(o.phone).replace(/[\s-]/g, ''), radiusKm: config.delivery.rangeKm, opens, closes,
    upiId: null, // payments go to the platform, never to the outlet's own UPI ID
  };
}

function createTenants({
  dir, registry, settlements, platformAdminToken, localities = [], log = console, appOptions = {},
  baseUrlFor, onOpen = () => {},
}) {
  const open = new Map(); // slug -> tenant
  let background = null; // { ms } once startBackground() ran

  function contextFor(r) {
    const brandJson = JSON.parse(r.brand || '{}');
    return { slug: r.slug, restaurantId: r.id, brand: withDefaults({ ...brandJson, id: r.slug, name: r.name }), profile: null, baseUrl: baseUrlFor(r) };
  }

  /** Open a restaurant's app (first use), optionally with its first outlet and menu. */
  function load(r, seed) {
    const context = contextFor(r);
    const profile = { brand: context.brand, outlets: seed?.outlets || [], menu: seed?.menu || [], localities };
    context.profile = profile;
    const tenant = { slug: r.slug, id: r.id, context, ctx: null, run: (fn) => als.run(context, fn) };
    tenant.ctx = tenant.run(() => createApp({
      dbPath: dir === ':memory:' ? ':memory:' : path.join(dir, `${r.slug}.db`),
      seed: profile,
      // The restaurant's head office token, or the platform's (support).
      adminToken: (token) => registry.checkToken(registry.byId(r.id) || r, token) || (Boolean(platformAdminToken) && sameToken(token, platformAdminToken)),
      connections: false,
      supabase: null,
      waClient: appOptions.waClient || createClient({ phoneNumberId: r.wa_phone_number_id || '', log }),
      log,
      ...appOptions,
    }));
    // Delivered orders go into the platform ledger.
    tenant.ctx.orders.events.on('status', (o) => {
      if (o.status === 'completed') record(tenant, o).catch((e) => log.error(`[platform] ledger for ${r.slug} ${o.code} failed: ${e.message}`));
    });
    open.set(r.slug, tenant);
    if (background) startTenant(tenant, background.ms);
    onOpen(tenant);
    return tenant;
  }

  /** How the customer paid, for the ledger. */
  function paidVia(tenant, o) {
    const link = tenant.ctx.store.paymentLinks(o.id).find((l) => l.status === 'paid' && l.payment_id);
    if (link) return { paidVia: 'gateway', paymentId: link.payment_id, provider: link.provider };
    if (o.payment_status === 'paid') {
      const outlet = tenant.ctx.orders.getOutlet(o.outlet_id);
      return { paidVia: outlet?.upi_id ? 'restaurant-upi' : 'platform-upi' };
    }
    return { paidVia: 'cash' };
  }

  async function record(tenant, o, now = new Date()) {
    if (o.payment_status === 'refunded') return null;
    const r = registry.byId(tenant.id);
    return settlements.recordOrder(r, { ...o, ...paidVia(tenant, o) }, now);
  }

  /** Delivered orders the ledger missed (a crash between delivery and the write). */
  async function backfill(tenant, sinceDays = 45) {
    const since = new Date(Date.now() - sinceDays * 86400000).toISOString();
    const codes = tenant.ctx.db.prepare("SELECT code FROM orders WHERE status = 'completed' AND updated_at >= ?").all(since).map((x) => x.code);
    let n = 0;
    for (const code of codes) {
      const o = tenant.ctx.orders.getOrder(code);
      // eslint-disable-next-line no-await-in-loop
      if (o && await record(tenant, o, new Date(o.updated_at))) n += 1;
    }
    return n;
  }

  function get(slug) {
    const t = open.get(slug);
    if (t) return t;
    const r = registry.get(slug);
    return r ? load(r) : null;
  }

  function startTenant(t, ms) {
    t.run(() => {
      const { dispatcher, reviews, payments, orders } = t.ctx;
      dispatcher.startSweeper(60 * ms);
      reviews.startTicker(60 * ms);
      payments.startSweeper(30 * ms);
      t.expiry = setInterval(() => { try { orders.expireUnpaid(); } catch (e) { log.error(`[orders] ${t.slug} expiry failed`, e.message); } }, 30 * ms);
      t.expiry.unref?.();
    });
  }

  function stopTenant(t) {
    const { dispatcher, reviews, payments, reports, db } = t.ctx;
    dispatcher.stopSweeper();
    reviews.stopTicker();
    payments.stopSweeper();
    clearInterval(t.expiry);
    t.ctx.gateway?.close();
    reports.close();
    try { if (db.isOpen !== false) { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } } catch { /* in-memory or closed */ }
  }

  return {
    get,
    /** A new restaurant's app, seeded with its first outlet and menu. */
    create(r, { outlet, menu = [] }) {
      const seed = { outlets: [seedOutlet(outlet, JSON.parse(r.brand))], menu };
      return load(r, seed);
    },
    seedOutlet,
    /** After name, brand, domain or WhatsApp number changed: reopen with the new details. */
    reload(slug) {
      const t = open.get(slug);
      if (!t) return null;
      if (dir === ':memory:') { // keep the data: just refresh the context in place
        Object.assign(t.context, contextFor(registry.get(slug)), { profile: t.context.profile });
        return t;
      }
      stopTenant(t);
      open.delete(slug);
      return get(slug);
    },
    /** Every restaurant's app (opens the ones not yet open). */
    all() { return registry.list().map((r) => get(r.slug)).filter(Boolean); },
    each(fn) { for (const t of open.values()) t.run(() => fn(t)); },
    backfill,
    record,
    startBackground(ms = 1000) {
      background = { ms };
      for (const t of this.all()) {
        startTenant(t, ms);
        backfill(t).then((n) => n && log.info?.(`[platform] ${t.slug}: ${n} delivered orders added to the ledger`)).catch((e) => log.error(`[platform] backfill ${t.slug} failed: ${e.message}`));
      }
    },
    close() { for (const t of open.values()) stopTenant(t); open.clear(); background = null; },
  };
}

module.exports = { createTenants, als };
