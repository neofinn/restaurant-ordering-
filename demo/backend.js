'use strict';

// The real ordering, routing and WhatsApp code running in the browser on an
// in-memory store, behind the same route handlers the server uses.

const { client: activeClient, brand } = require('../src/brand');
const { createMemoryStore } = require('../src/store/memory');
const { createOrderService, ValidationError, deliveryCharge } = require('../src/orders');
const config = require('./config');
const { createHandoffService } = require('../src/handoff');
const { authorize, createRoutes, recordOutbox, matchPath } = require('../src/routes/handlers');
const { createCrm } = require('../src/crm');
const { createMenuAdmin } = require('../src/menu-admin');
const { createMenuImages } = require('../src/whatsapp/menu-image');
const { createStaffAuth } = require('../src/staff-auth');
const { createStockService } = require('../src/stock');
const { createOutletAdmin } = require('../src/outlet-admin');
const { createIntegrations } = require('../src/integrations');
const { createOwnerLock } = require('../src/owner-lock');
const { seedSampleHistory } = require('./sample-history');
const { createReviews } = require('../src/reviews');
const { createBot, createSessionStore } = require('../src/whatsapp/bot');
const { notifyOnStatusChange, relayHandoffReplies, notifyOnPayment, notifyOnDelivery } = require('../src/whatsapp/notify');
const { createDispatcher } = require('../src/delivery/dispatcher');
const { createSimulatedFleet } = require('../src/delivery/simulator');
const { assignOutlet } = require('../src/geo');

const DEMO_PIN = '1234';

/**
 * state: a saved snapshot (from snapshot()) to continue from instead of starting
 * fresh. Used by the standalone demo pages, which keep the demo across page loads.
 */
function createDemoBackend({ state } = {}) {
  // Demo outlets stay open around the clock so it works at any hour.
  const seed = activeClient();
  const demoSeed = { ...seed, outlets: seed.outlets.map((o, i) => ({ ...o, opens: '00:00', closes: '00:00', sfxStoreCode: `DEMO-${i + 1}` })) };
  const store = createMemoryStore(demoSeed);
  // Sample history so CRM and analytics have data (demo only).
  if (state) store.importState(state.store); else seedSampleHistory(store);
  const orders = createOrderService(store);
  const handoffs = createHandoffService(store);
  const crm = createCrm({ store, orders });
  const menuAdmin = createMenuAdmin({ store });
  const reviewClient = { send: async (to, replies) => client.send(to, replies) };
  const reviews = createReviews({ store, orders, client: reviewClient, log: { error: () => {}, info: () => {} } });
  // Menu pictures shown inline in the demo chat (the server sends PNGs).
  const menuImages = createMenuImages({ menuItems: () => store.menuItems(), baseUrl: null });
  const bot = createBot({ orders, handoffs, crm, reviews, menuImages, sessions: createSessionStore(store), places: () => store.localities(), baseUrl: config.publicBaseUrl });
  const outbox = [];
  const client = recordOutbox({ send: async () => {} }, outbox);
  const quiet = { error: () => {}, info: () => {} };
  notifyOnStatusChange({ orders, client, crm, log: quiet });
  relayHandoffReplies({ handoffs, client, log: quiet });
  notifyOnPayment({ orders, client, log: quiet });
  let dispatcher;
  // Pretend Shadowfax, Porter and Borzo: the selector picks the best quote for each order,
  // and a booking with no rider moves to the next partner after 20 seconds (8 min in real life).
  const fleet = createSimulatedFleet({ onUpdate: (name, u) => dispatcher.handleUpdate(name, u) });
  dispatcher = createDispatcher({ orders, store, providers: fleet, reassignMinutes: 1 / 3, log: quiet });
  dispatcher.startSweeper(5000);
  notifyOnDelivery({ dispatcher, client, log: quiet });
  // Demo: check for due review requests every 5 seconds (asked 20 s after delivery).
  reviews.startTicker(5000);
  // Demo: unpaid UPI orders are cancelled after 3 minutes (see demo/config.js).
  setInterval(() => orders.expireUnpaid(), 5000);
  // Head office token is "demo"; every outlet's panel PIN is 1234.
  const staffAuth = createStaffAuth({ store, adminToken: 'demo' });
  if (!state) for (const o of orders.listOutlets()) staffAuth.setPin(o.id, DEMO_PIN);
  const stock = createStockService({ store, orders });
  const outletAdmin = createOutletAdmin({ store });
  // Connections tab works in the demo (kept in memory, nothing real connected).
  const integrations = createIntegrations({ store, cipher: { encrypt: (t) => t, decrypt: (t) => t }, liveTests: false, log: quiet });
  // Demo owner PIN for Connections: 246810.
  const ownerLock = createOwnerLock({ store });
  if (!ownerLock.hasPin()) ownerLock.setPin('246810', 'demo');
  const routes = createRoutes({ store, orders, handoffs, bot, outbox, dispatcher, crm, menuAdmin, staffAuth, stock, outletAdmin, integrations, ownerLock });

  /** Serve one API request. Resolves to { status, body }. */
  async function request(method, url, body, token = '', ownerToken = '') {
    const u = new URL(url, 'https://demo.local');
    for (const r of routes) {
      if (r.method !== method) continue;
      const params = matchPath(r.path, u.pathname);
      if (!params) continue;
      // Same access rules as the server: head office vs one outlet's tablet.
      const auth = r.admin || r.outlet ? staffAuth.resolve(token) : null;
      if (!authorize(r, auth)) return { status: 401, body: { error: 'Unauthorized' } };
      try {
        const out = await r.handle({ params, query: Object.fromEntries(u.searchParams), body: body || {}, auth, token, ownerToken });
        if (out && out.contentType) return { status: 200, body: out.text };
        if (out && out.httpStatus) return { status: out.httpStatus, body: out.body };
        return { status: 200, body: out };
      } catch (e) {
        if (e instanceof ValidationError) return { status: 400, body: { error: e.message, code: e.code } };
        console.error(e);
        return { status: 500, body: { error: 'Something went wrong' } };
      }
    }
    return { status: 404, body: { error: 'Not found' } };
  }

  // Demo: a new outlet without a PIN gets the demo PIN so its tablet can sign in.
  const ensureDemoPin = (id) => { if (!store.outletPinHash(id)) staffAuth.setPin(id, DEMO_PIN); };
  if (state?.outbox) outbox.push(...state.outbox);
  const snapshot = () => ({ v: 1, store: store.exportState(), outbox });
  return { request, ensureDemoPin, snapshot, orders, handoffs, store, dispatcher, assignOutlet, deliveryCharge, delivery: config.delivery, outlets: () => orders.listOutlets(), localities: () => store.localities() };
}

module.exports = { createDemoBackend, brandId: brand().id };
