'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const config = require('./config');
const { openDb } = require('./db');
const { brandPage } = require('./brand');
const { createSupabaseSync, dropTriggers } = require('./sync/supabase');
const { createSqliteStore } = require('./store/sqlite');
const { createOrderService, ValidationError } = require('./orders');
const { createHandoffService } = require('./handoff');
const { authorize, createRoutes, recordOutbox } = require('./routes/handlers');
const { createBot, createSessionStore } = require('./whatsapp/bot');
const { createClient } = require('./whatsapp/client');
const { createWebhookRouter } = require('./whatsapp/webhook');
const { notifyOnStatusChange, relayHandoffReplies, notifyOnPayment, notifyOnDelivery } = require('./whatsapp/notify');
const { createDispatcher } = require('./delivery/dispatcher');
const { createShadowfaxClient } = require('./delivery/shadowfax');
const { createSimulatedFleet } = require('./delivery/simulator');
const { createPorterClient } = require('./delivery/porter');
const { createRazorpayClient, validRazorpaySignature, parseRazorpayWebhook } = require('./razorpay');
const { createPhonePeClient, validPhonePeCallback, parsePhonePeCallback } = require('./phonepe');
const { createGateway } = require('./gateway');
const { createIntegrations } = require('./integrations');
const { createOwnerLock } = require('./owner-lock');
const { createBorzoClient, validBorzoSignature } = require('./delivery/borzo');
const { createSelector } = require('./delivery/selector');
const { qrPng } = require('./payments');
const { createCrm } = require('./crm');
const { createMenuAdmin } = require('./menu-admin');
const { createReviews } = require('./reviews');
const { createStaffAuth } = require('./staff-auth');
const { createStockService } = require('./stock');
const { createOutletAdmin } = require('./outlet-admin');
const { createReports } = require('./reports');
const { createMenuImages } = require('./whatsapp/menu-image');
const { computeAnalytics } = require('./analytics');

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Every delivery partner we have credentials for (or the simulated three). */
function deliveryProviders({ onUpdate }) {
  if (config.shadowfax.mode === 'simulate') return createSimulatedFleet({ onUpdate });
  const list = [];
  if (config.shadowfax.mode === 'live') list.push(createShadowfaxClient({ token: config.shadowfax.token, baseUrl: config.shadowfax.baseUrl }));
  if (config.porter.apiKey) list.push(createPorterClient({ apiKey: config.porter.apiKey, baseUrl: config.porter.baseUrl }));
  if (config.borzo.token) list.push(createBorzoClient({ token: config.borzo.token, baseUrl: config.borzo.baseUrl }));
  return list;
}

function createApp({
  dbPath = config.dbPath, waClient, enableDevTools = !config.production, log = console, deliveryPartner, seed, supabase = config.supabase, fetchImpl,
  paymentClient,
} = {}) {
  const db = openDb(dbPath, seed ? { seed } : {});
  // Connections saved in Head office → Connections override .env (applied before
  // anything below reads its settings).
  const connStore = createSqliteStore(db);
  let rebuild = () => {};
  const integrations = createIntegrations({ store: connStore, fetchImpl, log, onChange: (id) => rebuild(id) });
  const ownerLock = createOwnerLock({ store: connStore });
  // Optional copy of the data in Supabase; off unless both settings are given.
  const sync = supabase && supabase.url && supabase.serviceKey
    ? createSupabaseSync({ db, url: supabase.url, serviceKey: supabase.serviceKey, fetch: fetchImpl, log })
    : (dropTriggers(db), null);
  const store = createSqliteStore(db);
  const orders = createOrderService(store);
  const handoffs = createHandoffService(store);
  const crm = createCrm({ store, orders }); // before notifications, so points are credited first
  const menuAdmin = createMenuAdmin({ store });
  const stock = createStockService({ store, orders });
  const outletAdmin = createOutletAdmin({ store });
  const reports = createReports({ dbPath, store, crm, computeAnalytics });
  const staffAuth = createStaffAuth({ store, adminToken: config.adminToken });
  // Dev: keep messages the business sends on its own so the simulator can show them.
  const outbox = [];
  const baseClient = waClient || createClient({ log });
  const client = enableDevTools ? recordOutbox(baseClient, outbox) : baseClient;
  const reviews = createReviews({ store, orders, client, log });
  // The menu as pictures for WhatsApp, always from the live menu.
  const menuImages = createMenuImages({ menuItems: () => store.menuItems(), baseUrl: config.publicBaseUrl });
  const bot = createBot({ orders, handoffs, crm, reviews, menuImages, sessions: createSessionStore(store), places: () => store.localities() });
  notifyOnStatusChange({ orders, client, crm, log });
  relayHandoffReplies({ handoffs, client, log });
  notifyOnPayment({ orders, client, log });

  let dispatcher;
  const providers = deliveryPartner !== undefined ? (deliveryPartner ? [deliveryPartner] : [])
    : deliveryProviders({ onUpdate: (name, u) => dispatcher.handleUpdate(name, u) });
  const selector = createSelector({ store, minuteValue: config.dispatch.minuteValue });
  dispatcher = createDispatcher({
    orders, store, providers, selector, bookOn: config.shadowfax.bookOn, reassignMinutes: config.dispatch.reassignMinutes, log,
  });
  notifyOnDelivery({ dispatcher, client, log });

  // Payment gateway (Razorpay or PhonePe) when its keys are set; tests pass their own client.
  // Rebuilt when its settings change in Head office → Connections.
  const buildGateway = () => {
    const gatewayClient = paymentClient || ({
      razorpay: () => createRazorpayClient({ keyId: config.razorpay.keyId, keySecret: config.razorpay.keySecret, baseUrl: config.razorpay.baseUrl, fetchImpl }),
      phonepe: () => createPhonePeClient({ ...config.phonepe, callbackUrl: `${config.publicBaseUrl}/webhooks/phonepe`, fetchImpl }),
    }[config.paymentGateway()] || (() => null))();
    return gatewayClient
      ? createGateway({ client: gatewayClient, store, orders, publicBaseUrl: config.publicBaseUrl, windowMinutes: config.payments.windowMinutes, log })
      : null;
  };
  let gateway = buildGateway();
  let gatewaySweeping = false;
  const payments = {
    get current() { return gateway; },
    startSweeper(ms = 30000) { gatewaySweeping = ms; gateway?.startSweeper(ms); },
    stopSweeper() { gatewaySweeping = false; gateway?.stopSweeper(); },
  };
  rebuild = (id) => {
    if (['payments', 'razorpay', 'phonepe'].includes(id)) {
      gateway?.close();
      gateway = buildGateway();
      if (gateway && gatewaySweeping) gateway.startSweeper(gatewaySweeping);
      log.info?.(`[connections] payments now: ${gateway ? gateway.name : 'UPI QR, staff confirm'}`);
    }
    if (['shadowfax', 'porter', 'borzo'].includes(id) && deliveryPartner === undefined) {
      dispatcher.setProviders(deliveryProviders({ onUpdate: (name, u) => dispatcher.handleUpdate(name, u) }));
      log.info?.(`[connections] delivery partners now: ${dispatcher.providers.map((p) => p.name).join(', ') || 'none'}`);
    }
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Webhook needs the raw body for signature checks, so mount it before JSON parsing.
  app.use('/webhooks/whatsapp', createWebhookRouter({ db, bot, client, log }));

  // Keep the raw body: Borzo callbacks are verified against it.
  app.use(express.json({ limit: '100kb', verify: (req, res, buf) => { req.rawBody = buf; } }));
  // Health check for uptime monitors and the update script: the database must answer.
  const version = (() => { try { return fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim(); } catch { return 'dev'; } })();
  app.get('/healthz', (req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ ok: true, version });
    } catch (e) {
      res.status(503).json({ ok: false, version, error: e.message });
    }
  });

  // Menu pages as PNG for WhatsApp (?v= changes whenever the menu or prices change).
  app.get('/menu/page-:n.png', (req, res, next) => {
    try {
      const png = menuImages.png(req.params.n);
      if (!png) return res.sendStatus(404);
      res.type('png').set('Cache-Control', 'public, max-age=86400').send(png);
    } catch (e) { next(e); }
  });

  // Pay page: forwards to the gateway's payment page for this order (made on first use).
  app.get('/pay/:code', async (req, res, next) => {
    try {
      const code = String(req.params.code).toUpperCase();
      if (!gateway) return res.redirect(302, `/track.html?code=${encodeURIComponent(code)}`);
      const r = await gateway.linkFor(code);
      if (!r) return res.status(404).send('Order not found');
      res.redirect(302, r.url || `/track.html?code=${encodeURIComponent(code)}`);
    } catch (e) {
      log.error('[payments] could not open payment page', e.message);
      res.status(502).type('html').send('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><p style="font:16px system-ui;padding:16px">Sorry, online payment is not available right now. Please try again in a minute, or choose cash on delivery on your order page.</p>');
    }
  });

  // Razorpay webhook: signed with HMAC-SHA256 of the raw body.
  app.post('/webhooks/razorpay', async (req, res, next) => {
    if (!gateway) return res.sendStatus(404);
    if (!validRazorpaySignature(req.rawBody, req.get('x-razorpay-signature'), config.razorpay.webhookSecret)) return res.sendStatus(401);
    try {
      const result = await gateway.handleWebhook(parseRazorpayWebhook(req.body), req.get('x-razorpay-event-id'));
      res.json({ ok: true, result });
    } catch (e) { next(e); }
  });

  // PhonePe server-to-server callback: { response: base64 }, signed in X-VERIFY.
  app.post('/webhooks/phonepe', async (req, res, next) => {
    if (!gateway || gateway.name !== 'phonepe') return res.sendStatus(404);
    if (!validPhonePeCallback(req.body, req.get('x-verify'), config.phonepe.saltKey, config.phonepe.saltIndex)) return res.sendStatus(401);
    try {
      const parsed = parsePhonePeCallback(req.body);
      res.json({ ok: true, result: await gateway.handleWebhook(parsed, parsed.eventId) });
    } catch (e) { next(e); }
  });

  // UPI QR image for an order (sent as a WhatsApp image; WhatsApp can't show SVG).
  // With a gateway that makes dynamic UPI QR codes (PhonePe), it's the gateway's
  // own QR for this order, so the payment is reported back to us.
  app.get('/pay/:code/qr.png', async (req, res, next) => {
    try {
      const o = orders.getOrder(req.params.code);
      if (!o || !o.upi) return res.sendStatus(404);
      const own = gateway ? await gateway.qrFor(o.code).catch((e) => { log.error('[payments] QR failed', e.message); return null; }) : null;
      if (own) return res.type('png').set('Cache-Control', 'private, max-age=300').send(own);
      res.type('png').set('Cache-Control', 'private, max-age=3600').send(await qrPng(o.upi.link));
    } catch (e) { next(e); }
  });

  // Delivery partner callbacks. Shadowfax and Porter: a shared secret we agree
  // at onboarding (header, or ?token= in the URL we give them). Borzo signs the
  // body with HMAC-SHA256. Without a secret configured, callbacks are only
  // accepted outside production.
  const partnerAuthorized = (req, partner) => {
    if (partner === 'borzo') {
      return config.borzo.callbackSecret ? validBorzoSignature(req.rawBody, req.get('x-dv-signature'), config.borzo.callbackSecret) : !config.production;
    }
    const secret = partner === 'porter' ? config.porter.callbackToken : config.shadowfax.callbackToken;
    return secret ? safeEqual(req.get('x-callback-token') || req.query.token, secret) : !config.production;
  };

  for (const route of createRoutes({ store, orders, handoffs, bot, outbox, dispatcher, crm, menuAdmin, sync, staffAuth, stock, outletAdmin, reports, integrations, ownerLock })) {
    if (route.dev && !enableDevTools) continue;
    // Shadowfax may call back with POST or PUT.
    const methods = route.partner ? ['post', 'put'] : [route.method.toLowerCase()];
    for (const method of methods) app[method](route.path, async (req, res, next) => {
      const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
      const auth = route.admin || route.outlet ? staffAuth.resolve(token) : null;
      if (!authorize(route, auth)) return res.status(401).json({ error: 'Unauthorized' });
      if (route.partner && !partnerAuthorized(req, route.partner)) return res.status(401).json({ error: 'Unauthorized' });
      let out;
      try {
        out = await route.handle({ params: req.params, query: req.query, body: req.body || {}, auth, token, ownerToken: req.get('x-owner-unlock') || '' });
      } catch (e) { return next(e); }
      if (out && out.contentType) return res.type(out.contentType).attachment(out.filename).send(out.text);
      if (out && out.httpStatus) return res.status(out.httpStatus).json(out.body);
      res.json(out);
    });
  }

  // The WhatsApp simulator is a developer tool: not served in production.
  if (!enableDevTools) app.get(['/whatsapp-sim.html', '/whatsapp-sim'], (req, res) => res.status(404).send('Not found'));

  // Pages carry the client's name, logo and colours (see src/brand.js).
  const publicDir = path.join(__dirname, '..', 'public');
  const pages = new Map();
  app.get(/(\/|\.html|^\/[^.]*)$/, (req, res, next) => {
    let rel = req.path.endsWith('/') ? `${req.path}index.html` : req.path;
    if (!rel.endsWith('.html')) rel += '.html';
    const file = path.join(publicDir, rel);
    if (!file.startsWith(publicDir + path.sep)) return next();
    if (!pages.has(file)) {
      try { pages.set(file, brandPage(fs.readFileSync(file, 'utf8'))); } catch { return next(); }
    }
    res.type('html').send(pages.get(file));
  });
  app.use(express.static(publicDir, { extensions: ['html'] }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message, code: err.code });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return { app, db, store, orders, handoffs, bot, dispatcher, crm, menuAdmin, reviews, sync, staffAuth, stock, reports, version, integrations, ownerLock, payments, get gateway() { return gateway; } };
}

module.exports = { createApp };
