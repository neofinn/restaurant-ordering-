'use strict';

// HTTP API as plain handler functions. The Express app mounts these on the
// server (src/app.js) and the browser demo calls the same functions, so both
// run identical logic.
//
// Each route: { method, path, admin?, outlet?, dev?, handle({ params, query, body, auth }) }.
//   admin:  head office only (ADMIN_TOKEN).
//   outlet: a signed-in outlet tablet; auth.outletId is the only outlet it can touch.
// A handler returns a JSON-able value, or { httpStatus, body }, or
// { contentType, filename, text } for a file. ValidationError means 400.

const config = require('../config');
const { assignOutlet, isOpen, etaMinutes, rangeKm } = require('../geo');
const { deliveryCharge, canPayOnline } = require('../orders');
const { computeAnalytics } = require('../analytics');
const { placeAddress } = require('../geocode');
const { normalisePhone } = require('../orders');
const { qrSvg } = require('../payments');
const { AuthError } = require('../staff-auth');
const { brand } = require('../brand');
const { OwnerLockedError } = require('../owner-lock');

// Live orders: UPI orders waiting for payment show too, so staff can confirm a QR payment.
const ACTIVE = ['awaiting_payment', 'placed', 'accepted', 'preparing', 'ready', 'out_for_delivery'];
const IST_OFFSET_MS = 330 * 60 * 1000; // IST is UTC+5:30, no daylight saving
const DAY_MS = 24 * 60 * 60 * 1000;

const num = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v));
const notFound = (error) => ({ httpStatus: 404, body: { error } });
const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

const publicOutlet = (o, now) => ({
  id: o.id, slug: o.slug, name: o.name, city: o.city, address: o.address, lat: o.lat, lng: o.lng,
  phone: o.phone, deliveryRadiusKm: rangeKm(o), opens: o.opens, closes: o.closes, open: isOpen(o, now),
  upi: canPayOnline(o),
});

const publicPayment = (o) => ({
  method: o.payment_method, status: o.payment_status, label: o.paymentLabel,
  ...(o.upi && o.payment_status !== 'cod' ? { upiId: o.upi.upiId, payee: o.upi.payee, link: o.upi.link, gateway: Boolean(o.upi.gateway), qrSvg: qrSvg(o.upi.link) } : {}),
});

const publicDelivery = (d) => d && {
  partner: d.providerLabel || d.provider, status: d.status, label: d.label, riderName: d.rider_name, riderPhone: d.rider_phone,
  riderLat: d.rider_lat, riderLng: d.rider_lng, trackUrl: d.track_url,
};

/** Does this request decide for itself who may call the route? */
function authorize(route, auth) {
  if (route.admin) return auth?.role === 'admin';
  if (route.outlet) return auth?.role === 'outlet';
  return true;
}

function createRoutes({ store, orders, handoffs, bot, outbox, dispatcher, crm, menuAdmin, sync, staffAuth, stock, outletAdmin, reports, integrations, ownerLock }) {
  // Connections also need the owner's PIN (X-Owner-Unlock); see src/owner-lock.js.
  const LOCKED = { httpStatus: 423, body: { error: 'Locked: enter the owner PIN.', locked: true } };
  const owner = (fn) => (args) => (ownerLock && !ownerLock.check(args.ownerToken) ? LOCKED : fn(args));
  const unlockFailed = (e) => { if (e instanceof OwnerLockedError) return { httpStatus: 423, body: { error: e.message, locked: true } }; throw e; };
  // Reports run off the main thread on the server (src/reports.js); inline otherwise.
  reports ||= { analytics: (q) => computeAnalytics(store, q), customers: (q) => crm.list(q), customersCsv: (q) => crm.exportCsv(q) };
  // Head office reaches every outlet; an outlet tablet only its own.
  const scope = (auth, requested) => (auth.role === 'outlet' ? auth.outletId : Number(requested) || null);
  const mine = (auth, outletId) => auth.role === 'admin' || outletId === auth.outletId;
  const ownOrder = (auth, code) => {
    const o = orders.getOrder(code);
    return o && mine(auth, o.outlet_id) ? o : null;
  };
  const ownChat = (auth, id) => {
    const h = handoffs.get(Number(id));
    return h && mine(auth, h.outlet_id) ? h : null;
  };
  const authFail = (e) => {
    if (e instanceof AuthError) return { httpStatus: e.status, body: { error: e.message } };
    throw e;
  };

  // Live orders, chats and today's totals: the same routes for the admin panel
  // (/api/admin/…, every outlet) and the outlet panel (/api/outlet/…, its own).
  const staffRoutes = (base, flag) => [
    {
      method: 'GET', path: `${base}/orders`, ...flag,
      handle: ({ query, auth }) => orders.listOrders({
        outletId: scope(auth, query.outletId), statuses: query.status === 'all' ? null : ACTIVE, limit: query.limit,
      }),
    },
    {
      method: 'POST', path: `${base}/orders/:code/status`, ...flag,
      handle: ({ params, body, auth }) => (ownOrder(auth, params.code)
        ? orders.updateStatus(params.code, String(body.status || ''))
        : notFound('Order not found')),
    },
    {
      // Staff confirm a UPI payment arrived, say it hasn't, or switch the order to cash.
      method: 'POST', path: `${base}/orders/:code/payment`, ...flag,
      handle: ({ params, body, auth }) => (ownOrder(auth, params.code)
        ? orders.setPayment(params.code, String(body.status || ''))
        : notFound('Order not found')),
    },
    {
      // Delivery partner: (re)book a rider (best partner by price and speed), or use the outlet's own rider.
      method: 'POST', path: `${base}/orders/:code/delivery`, ...flag,
      handle: async ({ params, body, auth }) => {
        if (!ownOrder(auth, params.code)) return notFound('Order not found');
        if (body.action === 'own') return dispatcher.useOwnRider(params.code);
        if (body.action === 'book') return dispatcher.book(params.code);
        return { httpStatus: 400, body: { error: 'action must be "book" or "own"' } };
      },
    },
    {
      // Today's orders and revenue per outlet (IST day).
      method: 'GET', path: `${base}/summary`, ...flag,
      handle: ({ auth }) => store.summarySince(new Date(Math.floor((Date.now() + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS).toISOString())
        .filter((r) => mine(auth, r.outlet_id)),
    },
    {
      // Customer chats handed over from the WhatsApp bot.
      method: 'GET', path: `${base}/chats`, ...flag,
      handle: ({ query, auth }) => handoffs.list({ outletId: scope(auth, query.outletId), status: query.status === 'closed' ? 'closed' : 'open' }),
    },
    {
      method: 'POST', path: `${base}/chats/:id/reply`, ...flag,
      handle: ({ params, body, auth }) => {
        const h = ownChat(auth, params.id);
        const text = String(body.text || '').trim();
        if (!h) return notFound('Chat not found');
        if (h.status !== 'open') return { httpStatus: 400, body: { error: 'This chat is closed' } };
        if (!text) return { httpStatus: 400, body: { error: 'Message is empty' } };
        return handoffs.addMessage(h.id, 'out', text);
      },
    },
    {
      method: 'POST', path: `${base}/chats/:id/close`, ...flag,
      handle: ({ params, auth }) => {
        if (!ownChat(auth, params.id)) return notFound('Chat not found');
        handoffs.close(Number(params.id));
        return { ok: true };
      },
    },
  ];

  return [
    // ---- Customer API ------------------------------------------------------
    {
      method: 'GET', path: '/api/config',
      handle: () => {
        const p = config.pricing;
        return {
          gstPercent: p.gstPercent, packing: p.packingPerOrder, minDeliveryOrder: p.minDeliveryOrder,
          freeDeliveryAbove: p.freeDeliveryAbove,
          delivery: { ...config.delivery },
        };
      },
    },
    { method: 'GET', path: '/api/outlets', handle: () => orders.listOutlets().map((o) => publicOutlet(o, new Date())) },
    { method: 'GET', path: '/api/localities', handle: () => store.localities() },
    {
      // Find the outlet that should serve a location.
      method: 'POST', path: '/api/locate',
      handle: ({ body }) => {
        const lat = num(body.lat);
        const lng = num(body.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { httpStatus: 400, body: { error: 'lat and lng are required' } };
        const fulfilment = body.fulfilment === 'pickup' ? 'pickup' : 'delivery';
        const now = new Date();
        const a = assignOutlet(orders.listOutlets(), { lat, lng }, { fulfilment, now });
        return {
          fulfilment,
          outlet: a.outlet && publicOutlet(a.outlet, now),
          distanceKm: a.distanceKm,
          etaMinutes: a.outlet ? etaMinutes(fulfilment, a.distanceKm) : null,
          // Shadowfax charge for this distance, shown before the customer orders.
          deliveryCharge: a.outlet && fulfilment === 'delivery' ? deliveryCharge(a.distanceKm) : null,
          deliveryPartner: config.delivery.partner,
          freeDeliveryAbove: config.pricing.freeDeliveryAbove,
          reason: a.reason,
          pickupSuggestion: a.pickupSuggestion && { outlet: publicOutlet(a.pickupSuggestion.outlet, now), distanceKm: a.pickupSuggestion.distanceKm },
          nearby: a.ranked.slice(0, 3).map((r) => ({ outlet: publicOutlet(r.outlet, now), distanceKm: r.distanceKm, inRange: r.inRange })),
        };
      },
    },
    {
      // Typed delivery address -> known area (same matching as WhatsApp).
      method: 'POST', path: '/api/geocode',
      handle: ({ body }) => {
        const r = placeAddress(String(body.address || '').slice(0, 300), store.localities());
        return { place: r.place || null, candidates: r.candidates || null };
      },
    },
    {
      // Points saved on a WhatsApp number (only the count; no personal details).
      method: 'GET', path: '/api/loyalty',
      handle: ({ query }) => {
        const phone = normalisePhone(query.phone);
        if (!phone) return { httpStatus: 400, body: { error: 'Enter a valid 10-digit number' } };
        return { points: crm ? crm.balance(phone) : 0, rupeesPerPoint: config.loyalty.rupeesPerPoint };
      },
    },
    {
      method: 'GET', path: '/api/menu',
      handle: ({ query }) => {
        const outletId = Number(query.outletId) || null;
        if (outletId && !orders.getOutlet(outletId)) return notFound('Unknown outlet');
        return orders.categories(outletId);
      },
    },
    {
      method: 'POST', path: '/api/quote',
      handle: ({ body }) => {
        const fulfilment = body.fulfilment === 'pickup' ? 'pickup' : 'delivery';
        const { outlet, distanceKm } = orders.resolveOutlet({ fulfilment, lat: num(body.lat), lng: num(body.lng), outletId: Number(body.outletId) || null });
        return { outletId: outlet.id, distanceKm, ...orders.quote({ outletId: outlet.id, items: body.items, fulfilment, distanceKm }) };
      },
    },
    {
      method: 'POST', path: '/api/orders',
      handle: ({ body }) => ({ httpStatus: 201, body: { code: orders.createOrder({ ...body, channel: 'web' }).code } }),
    },
    {
      // Public order tracking. Personal details are trimmed.
      method: 'GET', path: '/api/orders/:code',
      handle: ({ params }) => {
        const o = orders.getOrder(params.code);
        if (!o) return notFound('Order not found');
        return {
          code: o.code, status: o.status, statusLabel: o.statusLabel, fulfilment: o.fulfilment,
          customerName: o.customer_name.split(' ')[0], items: o.items, subtotal: o.subtotal, packing: o.packing,
          gst: o.gst, deliveryFee: o.delivery_fee, deliveryKm: o.distance_km, deliveryPartner: o.fulfilment === 'delivery' ? config.delivery.partner : null,
          total: o.total, paymentMethod: o.payment_method,
          etaMinutes: o.etaMinutes, createdAt: o.created_at, updatedAt: o.updated_at, outlet: o.outlet,
          payment: publicPayment(o),
          payWithinMinutes: config.payments.windowMinutes,
          delivery: publicDelivery(o.delivery),
          loyalty: crm ? { points: crm.pointsFor(o.total), earned: o.status === 'completed' } : null,
        };
      },
    },
    {
      // Customer taps "I've paid" on the tracking page.
      method: 'POST', path: '/api/orders/:code/paid',
      handle: ({ params }) => {
        const o = orders.claimPayment(params.code);
        return o ? { payment: publicPayment(o) } : notFound('Order not found');
      },
    },
    {
      // Customer switches a waiting UPI order to cash/UPI on delivery (tracking page).
      method: 'POST', path: '/api/orders/:code/cash',
      handle: ({ params }) => {
        const o = orders.getOrder(params.code);
        if (!o) return notFound('Order not found');
        if (!['pending', 'claimed'].includes(o.payment_status)) return { payment: publicPayment(o) };
        return { payment: publicPayment(orders.setPayment(o.code, 'cod', new Date(), 'customer')) };
      },
    },

    // ---- Outlet staff (admin) ---------------------------------------------
    {
      // Supabase copy: pending rows, last sync time and last error.
      method: 'GET', path: '/api/admin/sync', admin: true,
      handle: () => (sync ? sync.status() : { enabled: false }),
    },
    ...staffRoutes('/api/admin', { admin: true }),
    ...staffRoutes('/api/outlet', { outlet: true }),

    // ---- Outlet panel (/outlet/) -----------------------------------------
    {
      method: 'POST', path: '/api/outlet/login',
      handle: ({ body }) => {
        try {
          const s = staffAuth.login(body.outletId, body.pin);
          return { token: s.token, outlet: orders.getOutlet(s.outletId) };
        } catch (e) { return authFail(e); }
      },
    },
    { method: 'POST', path: '/api/outlet/logout', outlet: true, handle: ({ token }) => { staffAuth.logout(token); return { ok: true }; } },
    { method: 'GET', path: '/api/outlet/me', outlet: true, handle: ({ auth }) => orders.getOutlet(auth.outletId) },
    {
      // Read-only: head office controls stock. Shows what's off and what's running low.
      method: 'GET', path: '/api/outlet/stock', outlet: true,
      handle: ({ auth }) => orders.menuFor(auth.outletId),
    },
    {
      // A busy kitchen can pause new orders; the next nearest outlet takes them.
      method: 'PATCH', path: '/api/outlet/me', outlet: true,
      handle: ({ body, auth }) => {
        if (typeof body.acceptingOrders === 'boolean') store.setAccepting(auth.outletId, body.acceptingOrders);
        return orders.getOutlet(auth.outletId);
      },
    },

    // ---- Head office: stock and outlet logins ------------------------------
    { method: 'GET', path: '/api/admin/stock', admin: true, handle: () => stock.board() },
    {
      // { outletId | 'all', itemId, available?: bool, remaining?: number | null }
      method: 'POST', path: '/api/admin/stock', admin: true,
      handle: ({ body }) => stock.set(body),
    },
    { method: 'GET', path: '/api/admin/logins', admin: true, handle: () => staffAuth.loginStatus() },
    {
      method: 'POST', path: '/api/admin/outlets/:id/pin', admin: true,
      handle: ({ params, body }) => {
        if (!orders.getOutlet(Number(params.id))) return notFound('Unknown outlet');
        try { staffAuth.setPin(Number(params.id), body.pin); } catch (e) { return authFail(e); }
        return { ok: true };
      },
    },
    {
      method: 'POST', path: '/api/admin/outlets/:id/sign-out', admin: true,
      handle: ({ params }) => { staffAuth.signOutOutlet(Number(params.id)); return { ok: true }; },
    },
    {
      // Partner callbacks (Shadowfax). Mounted by the server with its own auth check.
      method: 'POST', path: '/webhooks/shadowfax', partner: 'shadowfax',
      handle: ({ body }) => {
        dispatcher.handleCallback(body);
        return { ok: true };
      },
    },
    {
      method: 'POST', path: '/webhooks/porter', partner: 'porter',
      handle: ({ body }) => { dispatcher.handleWebhook('porter', body); return { ok: true }; },
    },
    {
      method: 'POST', path: '/webhooks/borzo', partner: 'borzo',
      handle: ({ body }) => { dispatcher.handleWebhook('borzo', body); return { ok: true }; },
    },
    { method: 'GET', path: '/api/admin/outlets', admin: true, handle: () => orders.listOutlets() },

    // ---- Connections: payment gateways, UPI, WhatsApp, delivery partners ----
    ...(integrations ? [
      { method: 'GET', path: '/api/admin/connections', admin: true, handle: owner(() => integrations.describe()) },
      {
        method: 'PUT', path: '/api/admin/connections/:id', admin: true,
        handle: owner(({ params, body }) => integrations.save(params.id, body.values || {}, 'owner')),
      },
      { method: 'POST', path: '/api/admin/connections/:id/test', admin: true, handle: owner(({ params }) => integrations.test(params.id)) },
      ...(ownerLock ? [
        { method: 'GET', path: '/api/admin/owner/status', admin: true, handle: ({ ownerToken }) => ownerLock.status(ownerToken) },
        {
          method: 'POST', path: '/api/admin/owner/unlock', admin: true,
          handle: ({ body }) => { try { return ownerLock.unlock(String(body.pin || '')); } catch (e) { return unlockFailed(e); } },
        },
        { method: 'POST', path: '/api/admin/owner/lock', admin: true, handle: ({ ownerToken }) => { ownerLock.lock(ownerToken); return { ok: true }; } },
        {
          method: 'POST', path: '/api/admin/owner/pin', admin: true,
          handle: owner(({ body }) => { ownerLock.changePin(String(body.current || ''), String(body.next || '')); return { ok: true }; }),
        },
      ] : []),
    ] : []),

    // ---- CRM & loyalty --------------------------------------------------
    { method: 'GET', path: '/api/admin/customers', admin: true, handle: ({ query }) => reports.customers(query) },
    {
      method: 'GET', path: '/api/admin/customers.csv', admin: true,
      handle: async ({ query }) => ({ contentType: 'text/csv', filename: `${brand().id}-customers.csv`, text: await reports.customersCsv(query) }),
    },
    { method: 'GET', path: '/api/admin/customers/:phone', admin: true, handle: ({ params }) => crm.get(params.phone) || notFound('Customer not found') },
    { method: 'PATCH', path: '/api/admin/customers/:phone', admin: true, handle: ({ params, body }) => crm.update(params.phone, body) || notFound('Customer not found') },
    {
      // Redeem (negative) or adjust loyalty points.
      method: 'POST', path: '/api/admin/customers/:phone/points', admin: true,
      handle: ({ params, body }) => crm.adjustPoints(params.phone, body.points, body.note, body.kind === 'redeem' ? 'redeem' : 'adjust') || notFound('Customer not found'),
    },

    // ---- Menu management ------------------------------------------------
    { method: 'GET', path: '/api/admin/menu', admin: true, handle: () => ({ items: menuAdmin.list(), lastChange: menuAdmin.lastChange() }) },
    { method: 'POST', path: '/api/admin/menu', admin: true, handle: ({ body }) => ({ httpStatus: 201, body: menuAdmin.add(body) }) },
    { method: 'PATCH', path: '/api/admin/menu/:id', admin: true, handle: ({ params, body }) => menuAdmin.update(params.id, body) || notFound('Dish not found') },
    { method: 'POST', path: '/api/admin/menu/bulk-price', admin: true, handle: ({ body }) => menuAdmin.bulkPrice(body) },
    { method: 'POST', path: '/api/admin/menu/undo', admin: true, handle: () => menuAdmin.undo() },

    // ---- Analytics ------------------------------------------------------
    { method: 'GET', path: '/api/admin/analytics', admin: true, handle: ({ query }) => reports.analytics(query) },
    {
      // Edit details (name, address, location, phone, hours, UPI, Shadowfax code) or pause.
      method: 'PATCH', path: '/api/admin/outlets/:id', admin: true,
      handle: ({ params, body }) => outletAdmin.update(Number(params.id), body) || notFound('Unknown outlet'),
    },
    {
      // Open a new outlet. Returns { outlet, nearest } (nearest other outlet, as a sanity check).
      method: 'POST', path: '/api/admin/outlets', admin: true,
      handle: ({ body }) => ({ httpStatus: 201, body: outletAdmin.add(body) }),
    },
    { method: 'GET', path: '/api/admin/outlets/:id/menu', admin: true, handle: ({ params }) => orders.menuFor(Number(params.id)) },
    {
      // Menu as a product feed for WhatsApp / Meta Commerce Manager. One catalog
      // serves every outlet; product ids (RC-<id>) map back to menu items, and the
      // bot routes catalog carts to the nearest outlet by the customer's location.
      method: 'GET', path: '/api/admin/catalog.csv', admin: true,
      handle: () => {
        const base = config.publicBaseUrl;
        const header = ['id', 'title', 'description', 'availability', 'condition', 'price', 'link', 'image_link', 'brand', 'product_type'];
        const rows = orders.menuFor(null).map((i) => [
          `RC-${i.id}`, i.name, i.description || `${i.veg ? 'Veg' : 'Non-veg'} · ${i.category}`, 'in stock', 'new',
          `${(i.price / 100).toFixed(2)} INR`, `${base}/#item-${i.id}`, `${base}/menu-photos/${i.id}.jpg`, brand().name, i.category,
        ]);
        return {
          contentType: 'text/csv', filename: `${brand().id}-catalog.csv`,
          text: [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n',
        };
      },
    },

    // ---- Development: WhatsApp simulator ------------------------------------
    {
      method: 'POST', path: '/api/dev/whatsapp', dev: true,
      handle: ({ body }) => {
        const { from = '919999999999', name = 'Guest', type = 'text', text, location, replyId, items, referenceId, status, amount, transactionId } = body;
        return bot.handle({ from, name, type, text, location, replyId, items, referenceId, status, amount, transactionId });
      },
    },
    {
      // Messages the business sent on its own (status updates, staff replies).
      method: 'GET', path: '/api/dev/whatsapp/outbox', dev: true,
      handle: ({ query }) => {
        const after = Number(query.after) || 0;
        return { last: outbox.at(-1)?.seq || 0, messages: outbox.filter((m) => m.seq > after && m.to === String(query.from)).map((m) => m.reply) };
      },
    },
  ];
}

/** Wrap a WhatsApp client so business-initiated messages are also kept for the simulator. */
function recordOutbox(client, outbox) {
  return {
    ...client,
    async send(to, replies) {
      for (const r of replies) outbox.push({ seq: (outbox.at(-1)?.seq || 0) + 1, to, reply: r });
      if (outbox.length > 1000) outbox.splice(0, outbox.length - 1000);
      return client.send(to, replies);
    },
  };
}

/** Match "/api/orders/:code" style paths. Returns params or null. */
function matchPath(pattern, path) {
  const a = pattern.split('/');
  const b = path.split('/');
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

module.exports = { authorize, createRoutes, recordOutbox, matchPath, ACTIVE };
