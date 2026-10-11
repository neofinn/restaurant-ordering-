'use strict';

// Platform server: many restaurants on one server, one payment gateway, one
// set of delivery partner accounts, weekly payouts. (Like an aggregator, but
// each restaurant keeps its own branded ordering site.)
//
//   <slug>.<PLATFORM_DOMAIN> (or the restaurant's own domain)
//       that restaurant's customer app, outlet panel and head office panel,
//       exactly as on a single-restaurant install (src/app.js), minus
//       Connections: payment, rider and WhatsApp keys are the platform's.
//   <PLATFORM_DOMAIN>
//       /                 marketplace: restaurants that deliver to you
//       /platform/        super-admin: restaurants, ledger, weekly settlements, Connections
//       /webhooks/*       Razorpay, WhatsApp and delivery partners call here;
//                         each call is passed to the restaurant it is about.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const config = require('../config');
const { ValidationError } = require('../orders');
const { createIntegrations } = require('../integrations');
const { createOwnerLock, OwnerLockedError } = require('../owner-lock');
const { validRazorpaySignature, parseRazorpayWebhook } = require('../razorpay');
const { validBorzoSignature } = require('../delivery/borzo');
const { assignOutlet, etaMinutes } = require('../geo');
const { deliveryCharge } = require('../orders');
const loadProfile = require('../client-profile');
const { openPlatformDb, settingsStore } = require('./db');
const { createRegistry, present, parseMenuCsv } = require('./registry');
const { createSettlements, weekOf, weekRange } = require('./settlement');
const { createTenants } = require('./tenants');
const { createRouteClient } = require('./route');

const P = config.platform;

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function createPlatform({
  dbPath = P.dbPath, tenantsDir = P.tenantsDir, domain = P.domain, adminToken = P.adminToken, name = P.name,
  fetchImpl, paymentClient, routeClient, deliveryPartner, waClient, log = console, enableDevTools = !config.production,
  localities,
} = {}) {
  const db = openPlatformDb(dbPath);
  const settings = settingsStore(db);
  let tenants = null;
  // Platform Connections: payment gateway, UPI, WhatsApp, delivery partners for
  // every restaurant (applied to the running config).
  const integrations = createIntegrations({
    store: settings, fetchImpl, log,
    onChange: (id) => tenants?.each((t) => t.ctx.reconnect(id)),
  });
  const ownerLock = createOwnerLock({ store: settings });
  const registry = createRegistry({ db, defaultCommissionPct: P.defaultCommissionPct });
  // Route needs Razorpay keys; built per use so Connections changes apply.
  const route = () => {
    if (routeClient !== undefined) return routeClient;
    return config.razorpay.keyId && config.razorpay.keySecret
      ? createRouteClient({ keyId: config.razorpay.keyId, keySecret: config.razorpay.keySecret, baseUrl: config.razorpay.baseUrl, fetchImpl })
      : null;
  };
  const terms = () => ({ commissionGstPct: P.commissionGstPct, tdsPct: P.tdsPct, pgFeePct: P.pgFeePct, platformPaysFoodGst: P.platformPaysFoodGst });
  const settlements = createSettlements({ db, terms, route, log });

  const base = new URL(config.publicBaseUrl);
  const rootHost = String(domain || base.hostname).toLowerCase();
  const baseUrlFor = (r) => (r.custom_domain ? `https://${r.custom_domain}` : `${base.protocol}//${r.slug}.${rootHost}${base.port ? `:${base.port}` : ''}`);
  tenants = createTenants({
    dir: tenantsDir, registry, settlements, platformAdminToken: adminToken, log, baseUrlFor,
    localities: localities || (() => { try { return loadProfile(process.env.CLIENT).localities || []; } catch { return []; } })(),
    appOptions: {
      enableDevTools, fetchImpl,
      ...(paymentClient !== undefined ? { paymentClient } : {}),
      ...(deliveryPartner !== undefined ? { deliveryPartner } : {}),
      ...(waClient ? { waClient } : {}),
    },
  });

  /** The restaurant a request is for, by host name, or null for the platform itself. */
  function restaurantFor(host) {
    const h = String(host || '').toLowerCase();
    if (!h || h === rootHost || h === `www.${rootHost}`) return null;
    if (h.endsWith(`.${rootHost}`)) return registry.get(h.slice(0, -rootHost.length - 1));
    if (h.endsWith('.localhost')) return registry.get(h.slice(0, -'.localhost'.length)); // local development
    return registry.byDomain(h);
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.get('/healthz', (req, res) => {
    try { db.prepare('SELECT 1').get(); res.json({ ok: true, platform: true, restaurants: registry.list().length }); } catch (e) { res.status(503).json({ ok: false, error: e.message }); }
  });

  // ---- A restaurant's own site --------------------------------------------
  const PAUSED_API = new Set(['/api/orders', '/api/quote']);
  app.use((req, res, next) => {
    const r = restaurantFor(req.hostname);
    if (!r) {
      if (req.hostname && req.hostname !== rootHost && !req.hostname.endsWith('localhost') && req.hostname !== '127.0.0.1' && req.hostname.includes('.')) {
        return res.status(404).type('html').send('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><p style="font:16px system-ui;padding:16px">No restaurant at this address.</p>');
      }
      return next();
    }
    if (r.status === 'paused' && req.method === 'POST' && PAUSED_API.has(req.path)) {
      return res.status(503).json({ error: `${r.name} isn't taking online orders right now.`, code: 'paused' });
    }
    const t = tenants.get(r.slug);
    // The restaurant's app answers everything on its host (nothing falls through to the platform's pages).
    t.run(() => t.ctx.app(req, res, (err) => (err ? next(err) : res.status(404).send('Not found'))));
  });

  // ---- Webhooks: one URL each for the whole platform -----------------------
  // WhatsApp: the restaurant whose number received the message.
  app.get('/webhooks/whatsapp', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === config.whatsapp.verifyToken) return res.status(200).send(req.query['hub.challenge']);
    res.sendStatus(403);
  });
  app.post('/webhooks/whatsapp', express.raw({ type: '*/*', limit: '1mb' }), (req, res, next) => {
    let body;
    try { body = JSON.parse(Buffer.from(req.body || '').toString('utf8')); } catch { return res.sendStatus(400); }
    const numberId = body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
    const r = numberId ? registry.byWhatsApp(numberId) : null;
    if (!r) return res.sendStatus(200); // not one of ours (or a status ping): acknowledge
    const t = tenants.get(r.slug);
    // The restaurant's own webhook handler checks the signature on the same raw body.
    t.run(() => t.ctx.app(req, res, next));
  });

  // Raw body kept for signature checks.
  app.use(express.json({ limit: '200kb', verify: (req, res, buf) => { req.rawBody = buf; } }));

  // Razorpay: the restaurant whose payment link was paid.
  app.post('/webhooks/razorpay', async (req, res, next) => {
    if (!validRazorpaySignature(req.rawBody, req.get('x-razorpay-signature'), config.razorpay.webhookSecret)) return res.sendStatus(401);
    try {
      const parsed = parseRazorpayWebhook(req.body);
      if (parsed.kind !== 'paid' || !parsed.linkId) return res.json({ ok: true, result: 'ignored' });
      const t = tenants.all().find((x) => x.ctx.store.paymentLinkById(parsed.linkId));
      if (!t || !t.ctx.gateway) {
        log.error(`[platform] Razorpay payment ${parsed.paymentId} for unknown link ${parsed.linkId}`);
        return res.json({ ok: true, result: 'unknown' });
      }
      const result = await t.run(() => t.ctx.gateway.handleWebhook(parsed, req.get('x-razorpay-event-id')));
      res.json({ ok: true, result, restaurant: t.slug });
    } catch (e) { next(e); }
  });

  // Delivery partners: every restaurant checks whether the booking is its own.
  const partnerAuthorized = (req, partner) => {
    if (partner === 'borzo') {
      return config.borzo.callbackSecret ? validBorzoSignature(req.rawBody, req.get('x-dv-signature'), config.borzo.callbackSecret) : !config.production;
    }
    const secret = partner === 'porter' ? config.porter.callbackToken : config.shadowfax.callbackToken;
    return secret ? safeEqual(req.get('x-callback-token') || req.query.token, secret) : !config.production;
  };
  for (const partner of ['shadowfax', 'porter', 'borzo']) {
    app.route(`/webhooks/${partner}`).post(handlePartner).put(handlePartner);
    // eslint-disable-next-line no-inner-declarations
    function handlePartner(req, res) {
      if (!partnerAuthorized(req, partner)) return res.status(401).json({ error: 'Unauthorized' });
      let matched = null;
      for (const t of tenants.all()) {
        const r = t.run(() => t.ctx.dispatcher.handleWebhook(partner, req.body || {}));
        if (r) { matched = t.slug; break; }
      }
      res.json({ ok: true, restaurant: matched });
    }
  }

  // ---- Marketplace (public) -------------------------------------------------
  const listing = (r) => {
    const b = JSON.parse(r.brand || '{}');
    return { slug: r.slug, name: r.name, url: baseUrlFor(r), emoji: b.emoji || '🍽️', description: b.description || '', colors: b.colors || {}, logo: b.logo || null };
  };
  app.get('/api/marketplace/restaurants', (req, res) => {
    res.json(registry.list().filter((r) => r.status === 'active').map(listing));
  });
  app.get('/api/marketplace/localities', (req, res) => {
    const seen = new Map();
    for (const t of tenants.all()) for (const l of t.ctx.store.localities()) seen.set(`${l.name}|${l.city}`, { name: l.name, city: l.city, lat: l.lat, lng: l.lng });
    res.json([...seen.values()].sort((a, b) => a.city.localeCompare(b.city) || a.name.localeCompare(b.name)));
  });
  // Restaurants that deliver to a point, nearest first; closed ones last.
  app.get('/api/marketplace/nearby', (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || req.query.lat === '' || req.query.lng === '') return res.status(400).json({ error: 'lat and lng are required' });
    const now = new Date();
    const out = [];
    for (const r of registry.list().filter((x) => x.status === 'active')) {
      const t = tenants.get(r.slug);
      const a = t.run(() => assignOutlet(t.ctx.orders.listOutlets(), { lat, lng }, { fulfilment: 'delivery', now }));
      const near = a.outlet ? { outlet: a.outlet, distanceKm: a.distanceKm, open: true } : a.ranked.find((x) => x.inRange);
      if (!near) continue;
      out.push({
        ...listing(r), open: Boolean(a.outlet), outlet: near.outlet.name, distanceKm: near.distanceKm,
        etaMinutes: etaMinutes('delivery', near.distanceKm), deliveryCharge: t.run(() => deliveryCharge(near.distanceKm)),
        url: `${baseUrlFor(r)}/?lat=${lat}&lng=${lng}`,
      });
    }
    out.sort((x, y) => Number(y.open) - Number(x.open) || x.distanceKm - y.distanceKm);
    res.json(out);
  });

  // ---- Super-admin API -------------------------------------------------------
  const api = express.Router();
  api.use((req, res, next) => {
    const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!adminToken || !safeEqual(token, adminToken)) return res.status(401).json({ error: 'Unauthorized' });
    next();
  });
  const LOCKED = { error: 'Locked: enter the owner PIN.', locked: true };
  const owner = (fn) => (req, res, next) => (!ownerLock.check(req.get('x-owner-unlock') || '') ? res.status(423).json(LOCKED) : fn(req, res, next));
  const wrap = (fn) => async (req, res, next) => {
    try {
      const out = await fn(req, res);
      if (out === undefined) return;
      if (out && out.httpStatus) return res.status(out.httpStatus).json(out.body);
      if (out && out.csv) return res.type('text/csv').attachment(out.csv.filename).send(out.csv.text);
      res.json(out);
    } catch (e) {
      if (e instanceof ValidationError) return res.status(400).json({ error: e.message, code: e.code });
      if (e instanceof OwnerLockedError) return res.status(423).json({ error: e.message, locked: true });
      if (/^(Unknown|Not a Monday|The week|This statement|Enter the|Release the|Connect Razorpay|Some transfers|Amount must|Say what)/.test(e.message)) return res.status(400).json({ error: e.message });
      next(e);
    }
  };
  const notFound = { httpStatus: 404, body: { error: 'Restaurant not found' } };
  const mustGet = (slug) => registry.get(slug);

  // Restaurant summary for the list: this week so far.
  const thisWeek = () => weekRange(weekOf());
  function summary(r) {
    const { from } = thisWeek();
    const s = db.prepare(`SELECT COUNT(*) FILTER (WHERE kind = 'order') AS orders, COALESCE(SUM(total), 0) AS sales,
      COALESCE(SUM(commission), 0) AS commission, COALESCE(SUM(payout), 0) AS payout FROM ledger WHERE restaurant_id = ? AND at >= ?`).get(r.id, from);
    const unsettled = db.prepare('SELECT COALESCE(SUM(payout), 0) AS n FROM ledger WHERE restaurant_id = ? AND settlement_id IS NULL').get(r.id).n;
    return { ...present(r), url: baseUrlFor(r), headOffice: `${baseUrlFor(r)}/admin/`, week: s, unsettled };
  }

  api.get('/overview', wrap(() => {
    const { from, weekStart, weekEnd } = thisWeek();
    const t = db.prepare(`SELECT COUNT(*) FILTER (WHERE kind = 'order') AS orders, COALESCE(SUM(total), 0) AS sales, COALESCE(SUM(commission), 0) AS commission,
      COALESCE(SUM(commission_gst), 0) AS commission_gst, COALESCE(SUM(delivery_fee) FILTER (WHERE json_extract(terms, '$.ownRider') = 0), 0) AS delivery_fees,
      COALESCE(SUM(gst_kept), 0) AS gst_kept, COALESCE(SUM(tds), 0) AS tds, COALESCE(SUM(payout), 0) AS payout FROM ledger WHERE at >= ?`).get(from);
    return {
      week: { weekStart, weekEnd, ...t }, restaurants: registry.list().length, gateway: config.paymentGateway(),
      route: Boolean(route()), lastClosedWeek: weekOf(new Date(Date.parse(from) - 1)), terms: terms(), domain: rootHost,
    };
  }));

  api.get('/restaurants', wrap(() => registry.list().map(summary)));
  api.get('/restaurants/:slug', wrap((req) => { const r = mustGet(req.params.slug); return r ? summary(r) : notFound; }));
  api.post('/restaurants', wrap((req) => {
    const b = req.body || {};
    const menu = b.menuCsv ? parseMenuCsv(b.menuCsv) : [];
    tenants.seedOutlet(b.outlet, { name: b.name, ...(b.brand || {}) }); // check before creating anything
    const { restaurant, adminToken: token } = registry.create(b);
    try {
      tenants.create(restaurant, { outlet: b.outlet, menu });
    } catch (e) {
      db.prepare('DELETE FROM restaurants WHERE id = ?').run(restaurant.id);
      throw e;
    }
    return { httpStatus: 201, body: { restaurant: summary(registry.get(restaurant.slug)), adminToken: token } };
  }));
  api.patch('/restaurants/:slug', wrap((req) => {
    const before = mustGet(req.params.slug);
    if (!before) return notFound;
    const r = registry.update(req.params.slug, req.body || {});
    if (['name', 'brand', 'custom_domain', 'wa_phone_number_id'].some((k) => k in (req.body || {}))) tenants.reload(r.slug);
    return summary(r);
  }));
  api.post('/restaurants/:slug/token', wrap((req) => {
    const out = registry.resetToken(req.params.slug);
    return out ? { adminToken: out.adminToken, headOffice: `${baseUrlFor(out.restaurant)}/admin/` } : notFound;
  }));
  // Ask Razorpay whether the linked account is ready to receive transfers.
  api.post('/restaurants/:slug/route-check', wrap(async (req) => {
    const r = mustGet(req.params.slug);
    if (!r) return notFound;
    if (!r.route_account) return { ok: false, message: 'Enter the Razorpay linked account ID (acc_…) first.' };
    const rp = route();
    if (!rp) return { ok: false, message: 'Connect Razorpay first (Connections).' };
    try {
      const a = await rp.account(r.route_account);
      registry.setRouteStatus(r.id, a.status);
      return { ok: a.status === 'activated', message: `Razorpay: ${a.name || a.id} is ${a.status}.`, status: a.status };
    } catch (e) { return { ok: false, message: e.message }; }
  }));

  // Ledger
  api.get('/ledger', wrap((req) => {
    const r = req.query.restaurant ? mustGet(req.query.restaurant) : null;
    if (req.query.restaurant && !r) return notFound;
    return settlements.open(r?.id);
  }));
  api.post('/restaurants/:slug/adjustments', wrap((req) => {
    const r = mustGet(req.params.slug);
    if (!r) return notFound;
    const rupees = Number(req.body?.amount);
    return { httpStatus: 201, body: settlements.addAdjustment(r.id, { amount: Math.round(rupees * 100), note: req.body?.note, by: 'platform' }) };
  }));
  api.post('/ledger/:id/retry-transfer', wrap((req) => settlements.retryTransfer(req.params.id)));

  // Settlements
  api.get('/settlements', wrap(() => ({ weeks: settlements.weeks(), lastWeek: weekOf(new Date(Date.parse(thisWeek().from) - 1)) })));
  api.get('/settlements/week/:monday', wrap((req) => settlements.week(req.params.monday)));
  api.post('/settlements/close', wrap(async (req) => {
    const monday = req.body?.week || weekOf(new Date(Date.parse(thisWeek().from) - 1));
    for (const t of tenants.all()) await tenants.backfill(t); // nothing delivered may be missing
    return { week: monday, made: settlements.closeWeek(monday) };
  }));
  api.get('/settlements/:id', wrap((req) => {
    const s = settlements.settlement(req.params.id);
    return s ? { ...s, restaurant: present(registry.byId(s.restaurant_id)), rows: settlements.rows(s.id) } : { httpStatus: 404, body: { error: 'Not found' } };
  }));
  api.post('/settlements/:id/release', wrap((req) => settlements.release(req.params.id, 'platform')));
  api.post('/settlements/:id/paid', wrap((req) => settlements.markPaid(req.params.id, req.body?.reference, 'platform')));
  api.get('/settlements/:id/statement.csv', wrap((req) => { const c = settlements.statementCsv(req.params.id); return c ? { csv: c } : { httpStatus: 404, body: { error: 'Not found' } }; }));
  api.get('/settlements/week/:monday/bank.csv', wrap((req) => ({ csv: settlements.bankCsv(req.params.monday) })));

  // Connections (platform keys), behind the owner PIN.
  api.get('/connections', owner(wrap(() => integrations.describe())));
  api.put('/connections/:id', owner(wrap((req) => integrations.save(req.params.id, req.body?.values || {}, 'owner'))));
  api.post('/connections/:id/test', owner(wrap((req) => integrations.test(req.params.id))));
  api.get('/owner/status', wrap((req) => ownerLock.status(req.get('x-owner-unlock') || '')));
  api.post('/owner/unlock', wrap((req) => ownerLock.unlock(String(req.body?.pin || ''))));
  api.post('/owner/lock', wrap((req) => { ownerLock.lock(req.get('x-owner-unlock') || ''); return { ok: true }; }));
  app.use('/platform/api', api);

  // ---- Platform pages ---------------------------------------------------------
  const publicDir = path.join(__dirname, '..', '..', 'public');
  const page = (rel) => {
    const html = fs.readFileSync(path.join(publicDir, rel), 'utf8');
    return html.replace(/\{\{platform\}\}/g, esc(name));
  };
  const pages = new Map();
  const send = (rel) => (req, res, next) => {
    try {
      if (!pages.has(rel) || enableDevTools) pages.set(rel, page(rel));
      res.type('html').send(pages.get(rel));
    } catch (e) { next(e); }
  };
  app.get(['/', '/index.html'], send('marketplace/index.html'));
  app.get(['/platform', '/platform/', '/platform/index.html'], send('platform/index.html'));
  app.use('/marketplace', express.static(path.join(publicDir, 'marketplace')));
  app.use('/platform', express.static(path.join(publicDir, 'platform')));
  app.get('/styles.css', (req, res) => res.sendFile(path.join(publicDir, 'styles.css')));

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message, code: err.code });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return {
    app, db, registry, tenants, settlements, integrations, ownerLock, restaurantFor, baseUrlFor,
    close() { tenants.close(); try { db.close(); } catch { /* closed */ } },
  };
}

module.exports = { createPlatform };
