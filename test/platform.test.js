'use strict';

// Platform mode: many restaurants on one server (subdomains), the platform's
// payment gateway, the per-order ledger, weekly settlements and Razorpay Route.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const config = require('../src/config');
const { createPlatform } = require('../src/platform/app');
const { orderShare, weekOf, weekRange } = require('../src/platform/settlement');
const { parseMenuCsv } = require('../src/platform/registry');
const { brand } = require('../src/brand');
const { PLACES } = require('./helpers');

const SECRET = 'whsec_platform';
const TOKEN = 'platform-admin-token-for-tests';
const silent = { info() {}, error: (...a) => (process.env.DEBUG_PLATFORM ? console.error(...a) : null), warn() {} };

const MENU_A = 'Category,Name,Price,Veg,Description\nMains,Paneer Tikka,250,yes,Smoky\nMains,Butter Chicken,350,no,\nBreads,Butter Naan,50,yes,';
const MENU_B = 'Bowls,Veg Ramen,300,yes,\nBowls,Chicken Ramen,380,no,';
const outletAt = (area, p) => ({ area, address: `SCO 1, ${area}`, city: 'Chandigarh', ...p, phone: '9876500000', opens: '00:00', closes: '00:00' });

// Requests with a Host header (fetch can't set it).
function request(port, { method = 'GET', path, host = 'order.test', body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { Host: host, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': data.length } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json; try { json = JSON.parse(text); } catch { json = text; }
        resolve({ status: res.statusCode, body: json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function world(t, { route = true } = {}) {
  const prev = { rp: { ...config.razorpay }, base: config.publicBaseUrl };
  Object.assign(config.razorpay, { keyId: 'rzp_test_k', keySecret: 's', webhookSecret: SECRET });
  config.publicBaseUrl = 'https://order.test';
  t.after(() => { Object.assign(config.razorpay, prev.rp); config.publicBaseUrl = prev.base; });

  // One fake Razorpay for the whole platform (link ids are unique across restaurants).
  const rp = { name: 'razorpay', links: [], refunds: [] };
  rp.createLink = async (args) => { rp.links.push(args); return { id: `plink_${rp.links.length}`, url: `https://rzp.io/i/${rp.links.length}`, status: 'created' }; };
  rp.refund = async (paymentId, opts) => { rp.refunds.push({ paymentId, ...opts }); return { id: `rfnd_${rp.refunds.length}`, status: 'processed' }; };
  const calls = [];
  let n = 0;
  const routeClient = route ? {
    transfer: async (paymentId, o) => { calls.push(['transfer', paymentId, o]); n += 1; return { id: `trf_${n}`, amount: o.amount, onHold: o.onHold }; },
    release: async (id) => { calls.push(['release', id]); return { id, onHold: false }; },
    reverse: async (id, amount) => { calls.push(['reverse', id, amount]); return { id: `rvrs_${id}`, amount }; },
    account: async (id) => ({ id, status: 'activated', name: 'Linked' }),
  } : null;
  const sent = [];
  const p = createPlatform({
    dbPath: ':memory:', tenantsDir: ':memory:', domain: 'order.test', adminToken: TOKEN, name: 'Test Platform',
    paymentClient: rp, routeClient, deliveryPartner: null, waClient: { send: async (to, replies) => { sent.push({ to, replies }); } },
    log: silent, enableDevTools: true, localities: require('./fixtures/localities'),
  });
  const server = p.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => { server.close(); p.close(); });
  const port = server.address().port;
  const call = (opts) => request(port, opts);
  const admin = (method, path, body) => call({ method, path: `/platform/api${path}`, body, headers: { Authorization: `Bearer ${TOKEN}` } });
  const hook = async (link, code, amount, payment) => {
    const raw = Buffer.from(JSON.stringify({
      event: 'payment_link.paid',
      payload: {
        payment_link: { entity: { id: link, reference_id: code, notes: { order: code }, status: 'paid', amount_paid: amount } },
        payment: { entity: { id: payment, amount, status: 'captured', method: 'upi' } },
      },
    }));
    const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
    return call({ method: 'POST', path: '/webhooks/razorpay', body: raw, headers: { 'X-Razorpay-Signature': sig, 'X-Razorpay-Event-Id': `evt_${payment}` } });
  };
  return { ...p, rp, calls, sent, call, admin, hook, port };
}

async function onboard(w, slug, name, menu, outlet, extra = {}) {
  const r = await w.admin('POST', '/restaurants', { slug, name, commission_pct: 20, menuCsv: menu, outlet, brand: { colors: { brand: '#0f766e' } }, route_account: 'acc_TESTACCOUNT01', ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

test('order share: online, cash, own rider, GST under section 9(5)', () => {
  const order = { code: 'X', fulfilment: 'delivery', subtotal: 100000, packing: 2000, gst: 5100, delivery_fee: 4000, total: 111100, delivery: { provider: 'shadowfax', status: 'DELIVERED' } };
  const t = { commissionPct: 20, commissionGstPct: 18, tdsPct: 0.1, pgFeePct: 0, platformPaysFoodGst: true };
  const online = orderShare({ ...order, paidVia: 'gateway' }, t);
  // food 1020.00; commission 204.00; GST on it 36.72; TDS 1.02 → 778.26
  assert.equal(online.commission, 20400);
  assert.equal(online.commission_gst, 3672);
  assert.equal(online.tds, 102);
  assert.equal(online.gst_kept, 5100);
  assert.equal(online.payout, 102000 - 20400 - 3672 - 102);
  assert.equal(online.collected_by, 'platform');

  const cash = orderShare({ ...order, paidVia: 'cash' }, t);
  assert.equal(cash.collected_by, 'restaurant');
  assert.equal(cash.payout, online.payout - order.total, 'restaurant kept the cash: it owes the rest');

  const own = orderShare({ ...order, paidVia: 'gateway', delivery: { status: 'OWN' } }, t);
  assert.equal(own.payout, online.payout + 4000, 'own rider: the delivery fee is the restaurant\'s');
  const gstToRestaurant = orderShare({ ...order, paidVia: 'gateway' }, { ...t, platformPaysFoodGst: false });
  assert.equal(gstToRestaurant.payout, online.payout + 5100);
  const pg = orderShare({ ...order, paidVia: 'gateway' }, { ...t, pgFeePct: 2 });
  assert.equal(pg.pg_fee, 2222);
});

test('weeks run Monday to Sunday in IST', () => {
  assert.equal(weekOf(new Date('2026-10-11T18:29:00Z')), '2026-10-05', 'Sunday 23:59 IST');
  assert.equal(weekOf(new Date('2026-10-11T18:30:00Z')), '2026-10-12', 'Monday 00:00 IST');
  assert.deepEqual(weekRange('2026-10-05'), { from: '2026-10-04T18:30:00.000Z', to: '2026-10-11T18:30:00.000Z', weekStart: '2026-10-05', weekEnd: '2026-10-11' });
  assert.throws(() => weekRange('2026-10-06'), /Not a Monday/);
});

test('menu CSV: header skipped, rupees, veg flag, errors named by line', () => {
  const m = parseMenuCsv('Category,Name,Price,Veg\nStarters,"Paneer, Chilli",₹249,yes\nMains,Chicken Curry,320.50,no');
  assert.deepEqual(m.map((x) => [x.category, x.name, x.price, x.veg]), [['Starters', 'Paneer, Chilli', 249, true], ['Mains', 'Chicken Curry', 320.5, false]]);
  assert.throws(() => parseMenuCsv('Mains,Dal,abc'), /Line 1 \(Dal\)/);
});

test('onboarding: own subdomain, own menu and branding, separate head office logins', async (t) => {
  const w = await world(t);
  assert.equal((await w.call({ path: '/platform/api/restaurants' })).status, 401);
  const a = await onboard(w, 'spice-route', 'Spice Route', MENU_A, outletAt('Sector 17', { lat: 30.7410, lng: 76.7790 }));
  const b = await onboard(w, 'noodle-bar', 'Noodle Bar', MENU_B, outletAt('Phase 7', PLACES.phase7));
  assert.match(a.adminToken, /^[0-9a-f]{48}$/);
  assert.equal(a.restaurant.url, 'https://spice-route.order.test');

  const bad = await w.admin('POST', '/restaurants', { slug: 'admin', name: 'X', outlet: outletAt('Y', PLACES.phase7) });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /reserved/);
  const dup = await w.admin('POST', '/restaurants', { slug: 'spice-route', name: 'X', outlet: outletAt('Y', PLACES.phase7) });
  assert.match(dup.body.error, /taken/);
  const badOutlet = await w.admin('POST', '/restaurants', { slug: 'new-one', name: 'X', outlet: { area: 'Y' } });
  assert.match(badOutlet.body.error, /address/);
  assert.equal(w.registry.get('new-one'), null, 'nothing is created when the outlet is wrong');

  // Each subdomain serves its own menu and brand.
  const menuA = await w.call({ host: 'spice-route.order.test', path: '/api/menu' });
  const menuB = await w.call({ host: 'noodle-bar.order.test', path: '/api/menu' });
  assert.deepEqual(menuA.body.flatMap((c) => c.items).map((i) => i.name).sort(), ['Butter Chicken', 'Butter Naan', 'Paneer Tikka']);
  assert.deepEqual(menuB.body.flatMap((c) => c.items).map((i) => i.name).sort(), ['Chicken Ramen', 'Veg Ramen']);
  const page = await w.call({ host: 'spice-route.order.test', path: '/' });
  assert.match(page.body, /Spice Route/);
  assert.match(page.body, /--brand:#0f766e/);
  assert.doesNotMatch(page.body, /Noodle Bar/);
  assert.equal((await w.call({ host: 'nobody.order.test', path: '/api/menu' })).status, 404);

  // Head office: each restaurant's token opens only its own; the platform's opens both (support).
  const ho = (host, token) => w.call({ host, path: '/api/admin/outlets', headers: { Authorization: `Bearer ${token}` } });
  assert.equal((await ho('spice-route.order.test', a.adminToken)).status, 200);
  assert.equal((await ho('noodle-bar.order.test', a.adminToken)).status, 401);
  assert.equal((await ho('noodle-bar.order.test', b.adminToken)).status, 200);
  assert.equal((await ho('noodle-bar.order.test', TOKEN)).status, 200);
  // Restaurants have no Connections: the keys are the platform's.
  assert.equal((await w.call({ host: 'spice-route.order.test', path: '/api/admin/connections', headers: { Authorization: `Bearer ${a.adminToken}` } })).status, 404);

  // A new token replaces the old one.
  const reset = await w.admin('POST', '/restaurants/spice-route/token');
  assert.equal((await ho('spice-route.order.test', a.adminToken)).status, 401);
  assert.equal((await ho('spice-route.order.test', reset.body.adminToken)).status, 200);

  // Marketplace: restaurants that deliver to the customer, with a link carrying the location.
  const near = await w.call({ path: `/api/marketplace/nearby?lat=${PLACES.phase7.lat}&lng=${PLACES.phase7.lng}` });
  assert.deepEqual(near.body.map((x) => x.slug), ['noodle-bar', 'spice-route']);
  assert.equal(near.body[0].url, `https://noodle-bar.order.test/?lat=${PLACES.phase7.lat}&lng=${PLACES.phase7.lng}`);
  assert.equal((await w.call({ path: `/api/marketplace/nearby?lat=${PLACES.ludhiana.lat}&lng=${PLACES.ludhiana.lng}` })).body.length, 0);
  assert.match((await w.call({ path: '/' })).body, /Test Platform/);

  // Paused: the site stays up, orders stop.
  await w.admin('PATCH', '/restaurants/noodle-bar', { status: 'paused' });
  const item = menuB.body[0].items[0].id;
  const paused = await w.call({ host: 'noodle-bar.order.test', method: 'POST', path: '/api/orders', body: { fulfilment: 'pickup', items: [{ id: item, qty: 1 }], name: 'A B', phone: '9812345678' } });
  assert.equal(paused.status, 503);
  assert.deepEqual((await w.call({ path: `/api/marketplace/nearby?lat=${PLACES.phase7.lat}&lng=${PLACES.phase7.lng}` })).body.map((x) => x.slug), ['spice-route']);
});

test('money: platform gateway pays, delivered orders reach the ledger, Route holds, weekly release nets cash dues', async (t) => {
  const w = await world(t);
  await onboard(w, 'spice-route', 'Spice Route', MENU_A, outletAt('Sector 17', { lat: 30.7410, lng: 76.7790 }));
  await onboard(w, 'noodle-bar', 'Noodle Bar', MENU_B, outletAt('Phase 7', PLACES.phase7), { route_account: '' });
  const A = w.tenants.get('spice-route');
  const B = w.tenants.get('noodle-bar');

  const place = async (host, items, extra = {}) => {
    const r = await w.call({ host, method: 'POST', path: '/api/orders', body: { fulfilment: 'delivery', ...PLACES.sector22, items, name: 'Rohit Sharma', phone: '9812345678', address: 'House 5, Sector 22', ...extra } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const tn = w.tenants.get(host.split('.')[0]);
    return tn.run(() => tn.ctx.orders.getOrder(r.body.code));
  };
  const menuA = (await w.call({ host: 'spice-route.order.test', path: '/api/menu' })).body.flatMap((c) => c.items);
  const paneer = menuA.find((i) => i.name === 'Paneer Tikka');

  // Online order on A: the pay link and webhook go through the platform.
  const o1 = await place('spice-route.order.test', [{ id: paneer.id, qty: 4 }], { paymentMethod: 'upi' });
  assert.equal(o1.status, 'awaiting_payment');
  assert.match(o1.upi.link, /^https:\/\/spice-route\.order\.test\/pay\//, 'pay page on the restaurant\'s own address');
  const pay = await w.call({ host: 'spice-route.order.test', path: `/pay/${o1.code}` });
  assert.equal(pay.status, 302);
  assert.match(w.rp.links[0].callbackUrl, /^https:\/\/spice-route\.order\.test\/track\.html/);
  const paid = await w.hook('plink_1', o1.code, o1.total, 'pay_1');
  assert.equal(paid.body.result, 'paid');
  assert.equal(paid.body.restaurant, 'spice-route');

  // Cash order on A and an online order on B (no Route account).
  const o2 = await place('spice-route.order.test', [{ id: paneer.id, qty: 1 }]);
  const ramen = (await w.call({ host: 'noodle-bar.order.test', path: '/api/menu' })).body.flatMap((c) => c.items)[0];
  const o3 = await place('noodle-bar.order.test', [{ id: ramen.id, qty: 2 }], { paymentMethod: 'upi' });
  await w.call({ host: 'noodle-bar.order.test', path: `/pay/${o3.code}` });
  assert.equal((await w.hook('plink_2', o3.code, o3.total, 'pay_3')).body.restaurant, 'noodle-bar');

  // Deliver all three.
  const deliver = (tn, code) => tn.run(() => { for (const s of ['accepted', 'preparing', 'out_for_delivery', 'completed']) tn.ctx.orders.updateStatus(code, s); });
  deliver(A, o1.code);
  deliver(A, o2.code);
  deliver(B, o3.code);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const ledgerA = (await w.admin('GET', '/ledger?restaurant=spice-route')).body;
  const r1 = ledgerA.find((x) => x.order_code === o1.code);
  const r2 = ledgerA.find((x) => x.order_code === o2.code);
  const full = A.ctx.orders.getOrder(o1.code);
  // Own-rider delivery here (no partner booked): the fee is the restaurant's.
  assert.equal(r1.payout, orderShare({ ...full, paidVia: 'gateway' }, { commissionPct: 20, tdsPct: 0.1 }).payout);
  assert.equal(r1.collected_by, 'platform');
  assert.equal(r1.transfer_status, 'held');
  assert.equal(r1.transfer_id, 'trf_1');
  assert.deepEqual(w.calls[0], ['transfer', 'pay_1', { account: 'acc_TESTACCOUNT01', amount: r1.payout, onHold: true, notes: { order: o1.code, restaurant: 'spice-route' } }]);
  assert.equal(r2.collected_by, 'restaurant');
  assert.ok(r2.payout < 0, 'cash order: the restaurant owes commission');
  const r3 = (await w.admin('GET', '/ledger?restaurant=noodle-bar')).body[0];
  assert.equal(r3.transfer_status, 'none');
  assert.match(r3.transfer_error, /No Route linked account/);

  // Delivered twice (a retry) is still one row.
  await w.tenants.record(A, A.ctx.orders.getOrder(o1.code));
  assert.equal((await w.admin('GET', '/ledger?restaurant=spice-route')).body.length, 2);

  // An adjustment for A.
  assert.equal((await w.admin('POST', '/restaurants/spice-route/adjustments', { amount: -10, note: 'Packaging complaint' })).status, 201);
  assert.equal((await w.admin('POST', '/restaurants/spice-route/adjustments', { amount: 5 })).status, 400);

  // The week isn't over: can't close it.
  const week = weekOf();
  assert.equal((await w.admin('POST', '/settlements/close', { week })).status, 400);
  // Close it as if next Monday (the ledger rows are inside this week).
  const made = w.settlements.closeWeek(week, new Date(Date.parse(weekRange(week).to) + 1000));
  const sA = made.find((s) => s.restaurant_id === w.registry.get('spice-route').id);
  const sB = made.find((s) => s.restaurant_id === w.registry.get('noodle-bar').id);
  const net = r1.payout + r2.payout - 1000;
  assert.equal(sA.net, net);
  assert.equal(sA.orders, 2);
  assert.equal(sA.cash_collected, r2.total);
  assert.equal(sA.via_route, net, 'all of it comes out of the held transfer');
  assert.equal(sA.manual, 0);
  assert.equal(sA.status, 'ready');
  assert.equal(sB.manual, r3.payout, 'no Route account: paid by bank transfer');
  assert.equal(w.settlements.closeWeek(week, new Date(Date.parse(weekRange(week).to) + 1000)).length, 0, 'closing twice makes nothing new');

  // Release A: the dues are taken back from the held transfer, the rest released.
  const rel = await w.admin('POST', `/settlements/${sA.id}/release`);
  assert.equal(rel.status, 200, JSON.stringify(rel.body));
  assert.equal(rel.body.status, 'paid');
  assert.deepEqual(w.calls.slice(1), [['reverse', 'trf_1', r1.payout - net], ['release', 'trf_1']]);
  assert.equal((await w.admin('POST', `/settlements/${sA.id}/release`)).status, 400, 'only once');

  // B: bank file, then marked paid with the UTR.
  const bank = await w.admin('GET', `/settlements/week/${week}/bank.csv`);
  assert.match(bank.body, /Noodle Bar,MISSING,MISSING/);
  assert.doesNotMatch(bank.body, /Spice Route/);
  assert.equal((await w.admin('POST', `/settlements/${sB.id}/paid`, {})).status, 400);
  assert.equal((await w.admin('POST', `/settlements/${sB.id}/paid`, { reference: 'UTR123456' })).body.status, 'paid');

  const csv = await w.admin('GET', `/settlements/${sA.id}/statement.csv`);
  assert.match(csv.headers['content-disposition'], /spice-route-statement-/);
  assert.match(csv.body, /Packaging complaint/);
  assert.match(csv.body, new RegExp(`Net payable,${(net / 100).toFixed(2)}`));
});

test('a week where the restaurant owes money is carried forward, held transfers taken back', async (t) => {
  const w = await world(t);
  await onboard(w, 'spice-route', 'Spice Route', MENU_A, outletAt('Sector 17', { lat: 30.7410, lng: 76.7790 }));
  const r = w.registry.get('spice-route');
  const week = '2026-09-28';
  const at = new Date('2026-09-30T08:00:00Z');
  w.db.prepare(`INSERT INTO ledger (restaurant_id, kind, order_code, at, payment, collected_by, total, payout, payment_id, transfer_id, transfer_status, transfer_amount, created_at)
    VALUES (?, 'order', 'A1', ?, 'online', 'platform', 50000, 40000, 'pay_x', 'trf_x', 'held', 40000, ?)`).run(r.id, at.toISOString(), at.toISOString());
  w.settlements.addAdjustment(r.id, { amount: -60000, note: 'Cash commission', at });
  const [s] = w.settlements.closeWeek(week, new Date('2026-10-06T00:00:00Z'));
  assert.equal(s.net, -20000);
  assert.equal(s.status, 'ready', 'release takes the held transfer back');
  const done = await w.settlements.release(s.id);
  assert.equal(done.status, 'carried');
  assert.deepEqual(w.calls, [['reverse', 'trf_x', 40000]]);
  const next = w.settlements.open(r.id);
  assert.equal(next.length, 1);
  assert.equal(next[0].payout, -20000);
  assert.match(next[0].note, /carried from week of 2026-09-28/);
});

test('platform Connections need the owner PIN; restaurant context does not leak', async (t) => {
  const w = await world(t);
  assert.equal((await w.admin('GET', '/connections')).status, 423);
  await onboard(w, 'spice-route', 'Spice Route', MENU_A, outletAt('Sector 17', { lat: 30.7410, lng: 76.7790 }));
  const A = w.tenants.get('spice-route');
  assert.equal(A.run(() => brand().name), 'Spice Route');
  assert.equal(A.run(() => config.publicBaseUrl), 'https://spice-route.order.test');
  assert.notEqual(brand().name, 'Spice Route', 'outside a restaurant: the install\'s own profile');
  assert.equal(config.publicBaseUrl, 'https://order.test');
});
