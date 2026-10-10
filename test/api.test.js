'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const config = require('../src/config');
const { createApp } = require('../src/app');
const { PLACES } = require('./helpers');

const silent = { info() {}, error() {} };

async function start() {
  const sent = [];
  const waClient = { enabled: true, send: async (to, replies) => { sent.push({ to, replies }); } };
  const ctx = createApp({ dbPath: ':memory:', seed: require('./fixtures/seed'), waClient, enableDevTools: true, log: silent, deliveryPartner: null });
  // Open 24h so tests don't depend on the wall clock.
  ctx.db.exec("UPDATE outlets SET opens = '00:00', closes = '00:00'");
  const server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };
  return { ...ctx, sent, call, base, close: () => server.close() };
}

const admin = { Authorization: `Bearer ${config.adminToken}` };

test('web ordering end to end: locate, menu, quote, order, track, status', async (t) => {
  const s = await start();
  t.after(s.close);

  const loc = await s.call('POST', '/api/locate', PLACES.panchkula5);
  assert.equal(loc.status, 200);
  assert.equal(loc.body.outlet.slug, 'sec-11-pkl');
  assert.ok(loc.body.etaMinutes > 0);

  const menu = await s.call('GET', `/api/menu?outletId=${loc.body.outlet.id}`);
  const paneer = menu.body.flatMap((c) => c.items).find((i) => i.name === 'Chilli Paneer Dry');

  const items = [{ id: paneer.id, qty: 2 }];
  const quote = await s.call('POST', '/api/quote', { fulfilment: 'delivery', ...PLACES.panchkula5, items });
  assert.equal(quote.status, 200);
  assert.equal(quote.body.subtotal, paneer.price * 2);

  const bad = await s.call('POST', '/api/orders', { fulfilment: 'delivery', ...PLACES.panchkula5, items, name: 'R', phone: '123', address: 'House 5, Sector 5' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /mobile/);

  const created = await s.call('POST', '/api/orders', { fulfilment: 'delivery', ...PLACES.panchkula5, items, name: 'Rohit Sharma', phone: '9812345678', address: 'House 5, Sector 5' });
  assert.equal(created.status, 201);
  const { code } = created.body;

  const track = await s.call('GET', `/api/orders/${code}`);
  assert.equal(track.body.status, 'placed');
  assert.equal(track.body.customerName, 'Rohit');
  assert.equal(track.body.phone, undefined, 'tracking must not leak phone');
  assert.equal(track.body.total, quote.body.total);

  assert.equal((await s.call('GET', '/api/admin/orders')).status, 401);
  const live = await s.call('GET', `/api/admin/orders?outletId=${loc.body.outlet.id}`, undefined, admin);
  assert.equal(live.body[0].code, code);

  const accepted = await s.call('POST', `/api/admin/orders/${code}/status`, { status: 'accepted' }, admin);
  assert.equal(accepted.body.status, 'accepted');
  const skip = await s.call('POST', `/api/admin/orders/${code}/status`, { status: 'completed' }, admin);
  assert.equal(skip.status, 400);

  // Web orders don't trigger WhatsApp notifications.
  assert.equal(s.sent.length, 0);
});

test('head office pauses outlets and controls stock; counts run down with orders', async (t) => {
  const s = await start();
  t.after(s.close);
  await s.call('PATCH', '/api/admin/outlets/1', { acceptingOrders: false }, admin);
  const loc = await s.call('POST', '/api/locate', PLACES.sector22);
  assert.notEqual(loc.body.outlet.id, 1);

  const item = (await s.call('GET', '/api/menu?outletId=2')).body[0].items[0];
  await s.call('POST', '/api/admin/stock', { outletId: 2, itemId: item.id, available: false }, admin);
  assert.equal((await s.call('GET', '/api/menu?outletId=2')).body[0].items[0].available, false);
  assert.equal((await s.call('GET', '/api/menu?outletId=3')).body[0].items[0].available, true, 'other outlets unaffected');

  // A count: 3 left at outlet 2. Orders take from it; cancelling puts it back.
  const paneer = (await s.call('GET', '/api/menu?outletId=2')).body.flatMap((c) => c.items).find((i) => i.name === 'Chilli Paneer Dry');
  let board = (await s.call('POST', '/api/admin/stock', { outletId: 2, itemId: paneer.id, remaining: 3 }, admin)).body;
  assert.equal(board.items.find((i) => i.id === paneer.id).outlets[2].remaining, 3);
  const order = (qty) => s.call('POST', '/api/orders', { fulfilment: 'pickup', outletId: 2, items: [{ id: paneer.id, qty }], name: 'Rohit', phone: '9812345678' });
  const tooMany = await order(4);
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.error, /Only 3 × Chilli Paneer Dry left/);
  const o = await order(3);
  assert.equal(o.status, 201);
  let dish = (await s.call('GET', '/api/menu?outletId=2')).body.flatMap((c) => c.items).find((i) => i.id === paneer.id);
  assert.deepEqual([dish.available, dish.remaining], [false, 0], 'sold out at 0');
  await s.call('POST', `/api/admin/orders/${o.body.code}/status`, { status: 'cancelled' }, admin);
  dish = (await s.call('GET', '/api/menu?outletId=2')).body.flatMap((c) => c.items).find((i) => i.id === paneer.id);
  assert.deepEqual([dish.available, dish.remaining], [true, 3]);

  // Empty = no limit again; 'all' changes every outlet at once.
  board = (await s.call('POST', '/api/admin/stock', { outletId: 'all', itemId: paneer.id, remaining: null }, admin)).body;
  assert.ok(Object.values(board.items.find((i) => i.id === paneer.id).outlets).every((c) => c.remaining === null));
  assert.equal((await s.call('POST', '/api/admin/stock', { outletId: 2, itemId: paneer.id, remaining: -1 }, admin)).status, 400);
});

test('outlet panel: PIN login, only its own orders and chats, stock is read-only', async (t) => {
  const s = await start();
  t.after(s.close);
  const paneer = (await s.call('GET', '/api/menu')).body.flatMap((c) => c.items).find((i) => i.name === 'Chilli Paneer Dry');
  const order = (outletId) => s.call('POST', '/api/orders', { fulfilment: 'pickup', outletId, items: [{ id: paneer.id, qty: 1 }], name: 'Rohit', phone: '9812345678' });
  const mine = (await order(2)).body.code;
  const theirs = (await order(3)).body.code;

  assert.equal((await s.call('POST', '/api/outlet/login', { outletId: 2, pin: '1234' })).status, 401, 'no PIN set yet');
  assert.equal((await s.call('POST', '/api/admin/outlets/2/pin', { pin: '12' }, admin)).status, 400);
  assert.equal((await s.call('POST', '/api/admin/outlets/2/pin', { pin: '482913' })).status, 401, 'only head office sets PINs');
  await s.call('POST', '/api/admin/outlets/2/pin', { pin: '482913' }, admin);
  assert.equal((await s.call('POST', '/api/outlet/login', { outletId: 2, pin: '000000' })).status, 401);
  const login = await s.call('POST', '/api/outlet/login', { outletId: 2, pin: '482913' });
  assert.equal(login.status, 200);
  assert.equal(login.body.outlet.id, 2);
  const tab = { Authorization: `Bearer ${login.body.token}` };

  const live = (await s.call('GET', '/api/outlet/orders?outletId=3', undefined, tab)).body;
  assert.deepEqual(live.map((o) => o.code), [mine], 'asking for another outlet still returns only its own');
  assert.equal((await s.call('POST', `/api/outlet/orders/${theirs}/status`, { status: 'accepted' }, tab)).status, 404);
  assert.equal((await s.call('POST', `/api/outlet/orders/${mine}/status`, { status: 'accepted' }, tab)).body.status, 'accepted');
  assert.ok((await s.call('GET', '/api/outlet/summary', undefined, tab)).body.every((r) => r.outlet_id === 2));

  // Head office screens and stock changes are closed to outlet tablets.
  for (const [m, p, b] of [['GET', '/api/admin/orders'], ['GET', '/api/admin/customers'], ['GET', '/api/admin/analytics'],
    ['GET', '/api/admin/stock'], ['POST', '/api/admin/stock', { outletId: 2, itemId: paneer.id, available: false }],
    ['PATCH', '/api/admin/menu/1', { price: 1 }]]) {
    assert.equal((await s.call(m, p, b, tab)).status, 401, `${m} ${p}`);
  }
  assert.equal((await s.call('GET', '/api/outlet/orders', undefined, admin)).status, 401, 'outlet routes need an outlet login');
  const stock = (await s.call('GET', '/api/outlet/stock', undefined, tab)).body;
  assert.ok(stock.find((i) => i.id === paneer.id).available);
  // The outlet can still pause new orders when the kitchen is overloaded.
  assert.equal((await s.call('PATCH', '/api/outlet/me', { acceptingOrders: false }, tab)).body.accepting_orders, 0);

  const status = (await s.call('GET', '/api/admin/logins', undefined, admin)).body.find((r) => r.outletId === 2);
  assert.deepEqual([status.hasPin, status.devices], [true, 1]);
  // Changing the PIN (or "sign out tablets") signs the outlet's tablets out.
  await s.call('POST', '/api/admin/outlets/2/pin', { pin: '777123' }, admin);
  assert.equal((await s.call('GET', '/api/outlet/orders', undefined, tab)).status, 401);

  // Five wrong PINs lock the outlet's login for a few minutes.
  for (let i = 0; i < 5; i++) await s.call('POST', '/api/outlet/login', { outletId: 2, pin: '000000' });
  assert.equal((await s.call('POST', '/api/outlet/login', { outletId: 2, pin: '777123' })).status, 429);
});

test('head office opens a new outlet: it gets orders, stock and a tablet login', async (t) => {
  const s = await start();
  t.after(s.close);
  const site = { lat: 30.8205, lng: 76.7010 }; // New Chandigarh, away from the fixture outlets
  const body = {
    name: 'New Chandigarh', city: 'Mohali', address: 'SCO 12, Omaxe New Chandigarh 140901', phone: '98765 43210',
    // Open 24h (00:00-00:00) so the test doesn't depend on the clock.
    mapsLink: `https://www.google.com/maps/place/Test+Kitchen/@${site.lat},${site.lng},17z`, opens: '00:00', closes: '00:00', upiId: 'tk-newchd@okaxis',
  };
  assert.equal((await s.call('POST', '/api/admin/outlets', body)).status, 401, 'head office only');
  for (const [bad, msg] of [[{ mapsLink: 'https://example.com' }, /Couldn't read a location/], [{ mapsLink: undefined, lat: 76.6, lng: 30.7 }, /Location looks wrong/],
    [{ opens: '9am' }, /Opening time/], [{ upiId: 'nope' }, /UPI ID/], [{ address: '' }, /Address is required/]]) {
    const r = await s.call('POST', '/api/admin/outlets', { ...body, ...bad }, admin);
    assert.equal(r.status, 400);
    assert.match(r.body.error, msg);
  }
  const created = await s.call('POST', '/api/admin/outlets', body, admin);
  assert.equal(created.status, 201);
  const o = created.body.outlet;
  assert.equal(o.name, 'Test Kitchen - New Chandigarh');
  assert.deepEqual([o.lat, o.lng, o.phone, o.slug], [site.lat, site.lng, '+919876543210', 'new-chandigarh']);
  assert.ok(created.body.nearest.km > 0);
  assert.equal((await s.call('POST', '/api/admin/outlets', body, admin)).body.error, 'There is already an outlet called "Test Kitchen - New Chandigarh".');

  // Customers right next to it now get it, with the full menu in stock.
  assert.equal((await s.call('POST', '/api/locate', site)).body.outlet.id, o.id);
  assert.ok((await s.call('GET', `/api/menu?outletId=${o.id}`)).body.flatMap((c) => c.items).every((i) => i.available));
  assert.ok((await s.call('GET', '/api/admin/stock', undefined, admin)).body.outlets.some((x) => x.id === o.id));

  // Its tablet can log in once head office sets the PIN.
  await s.call('POST', `/api/admin/outlets/${o.id}/pin`, { pin: '2468' }, admin);
  assert.equal((await s.call('POST', '/api/outlet/login', { outletId: o.id, pin: '2468' })).status, 200);

  // Fix a pin dropped in the wrong place, change hours.
  const moved = await s.call('PATCH', `/api/admin/outlets/${o.id}`, { lat: 30.8150, lng: 76.7050, closes: '22:30' }, admin);
  assert.deepEqual([moved.body.lat, moved.body.closes], [30.815, '22:30']);
  assert.equal(moved.body.name, 'Test Kitchen - New Chandigarh', 'fields not sent stay as they were');
  assert.equal((await s.call('PATCH', `/api/admin/outlets/${o.id}`, { closes: '25:00' }, admin)).status, 400);
});

test('WhatsApp webhook: verification, signature, dedupe and status notifications', async (t) => {
  const s = await start();
  t.after(s.close);

  const v = await s.call('GET', `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${config.whatsapp.verifyToken}&hub.challenge=42`);
  assert.equal(v.body, 42);
  assert.equal((await s.call('GET', '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1')).status, 403);

  const from = '919811112222';
  const msg = (id, m) => ({ entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name: 'Neha' } }], messages: [{ id, from, ...m }] } }] }] });
  const post = async (body) => {
    const res = await s.call('POST', '/webhooks/whatsapp', body);
    await new Promise((r) => setImmediate(r));
    return res;
  };

  await post(msg('m1', { type: 'text', text: { body: 'hi' } }));
  await post(msg('m1', { type: 'text', text: { body: 'hi' } })); // redelivery
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0].replies[0].text, /Namaste Neha/);

  await post(msg('m2', { type: 'location', location: { latitude: PLACES.phase7.lat, longitude: PLACES.phase7.lng } }));
  assert.match(s.sent[1].replies[0].text, /Phase 7 Mohali/);

  const combo = s.orders.menuFor(4).find((i) => i.name === 'Noodles + Manchurian Combo');
  await post(msg('m3', { type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: `item:${combo.id}` } } }));
  await post(msg('m4', { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'qty:1' } } }));
  await post(msg('m5', { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'act:checkout' } } }));
  await post(msg('m6', { type: 'text', text: { body: 'Flat 3, Phase 7, near market' } }));
  await post(msg('m7', { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'act:place' } } }));
  const placed = s.sent.at(-1).replies[0].text;
  const code = placed.match(/\*(TK[2-9A-Z]{6})\*/)[1];

  await s.call('POST', `/api/admin/orders/${code}/status`, { status: 'accepted' }, admin);
  await new Promise((r) => setImmediate(r));
  assert.equal(s.sent.at(-1).to, from);
  assert.match(s.sent.at(-1).replies[0].text, /accepted your order/);

  // Signature enforcement when an app secret is configured.
  const prev = config.whatsapp.appSecret;
  config.whatsapp.appSecret = 'shh';
  t.after(() => { config.whatsapp.appSecret = prev; });
  const body = JSON.stringify(msg('m8', { type: 'text', text: { body: 'menu' } }));
  const unsigned = await fetch(`${s.base}/webhooks/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal(unsigned.status, 401);
  const sig = 'sha256=' + crypto.createHmac('sha256', 'shh').update(body).digest('hex');
  const signed = await fetch(`${s.base}/webhooks/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body });
  assert.equal(signed.status, 200);
});

test('dev WhatsApp simulator endpoint talks to the bot', async (t) => {
  const s = await start();
  t.after(s.close);
  const r = await s.call('POST', '/api/dev/whatsapp', { from: '919800000000', type: 'text', text: 'hi' });
  assert.equal(r.body[0].type, 'buttons');
});

test('catalog cart over the webhook, human handoff with staff replies, catalog feed', async (t) => {
  const s = await start();
  t.after(s.close);
  const from = '919822223333';
  const post = async (id, m) => {
    await s.call('POST', '/webhooks/whatsapp', { entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name: 'Gurpreet' } }], messages: [{ id, from, ...m }] } }] }] });
    await new Promise((r) => setImmediate(r));
  };

  const feed = await fetch(`${s.base}/api/admin/catalog.csv`, { headers: admin });
  const csv = await feed.text();
  assert.match(csv, /^id,title,description,availability,condition,price,link,image_link,brand,product_type\n/);
  const firstId = csv.split('\n')[1].split(',')[0];
  assert.match(firstId, /^RC-\d+$/);

  await post('c1', { type: 'order', order: { catalog_id: '1', text: '', product_items: [{ product_retailer_id: firstId, quantity: 3, item_price: 89, currency: 'INR' }] } });
  assert.match(s.sent.at(-1).replies[0].text, /Got your cart/);
  assert.match(s.sent.at(-1).replies[1].text, /Your order so far/);

  await post('c2', { type: 'text', text: { body: 'talk to someone please' } });
  assert.match(s.sent.at(-1).replies[0].text, /Connecting you to our team/);
  await post('c3', { type: 'text', text: { body: 'Can you make it without garlic?' } });
  const before = s.sent.length;

  const chats = await s.call('GET', '/api/admin/chats', undefined, admin);
  assert.equal(chats.body.length, 1);
  assert.equal(chats.body[0].messages.at(-1).body, 'Can you make it without garlic?');

  await s.call('POST', `/api/admin/chats/${chats.body[0].id}/reply`, { text: 'Yes ji, no garlic. Please share your location.' }, admin);
  await new Promise((r) => setImmediate(r));
  assert.equal(s.sent.length, before + 1);
  assert.equal(s.sent.at(-1).replies[0].text, 'Yes ji, no garlic. Please share your location.');

  await s.call('POST', `/api/admin/chats/${chats.body[0].id}/close`, {}, admin);
  await new Promise((r) => setImmediate(r));
  assert.match(s.sent.at(-1).replies[0].text, /closed this chat/);
  assert.equal((await s.call('GET', '/api/admin/chats', undefined, admin)).body.length, 0);
});

test('UPI on the web: QR on tracking, customer claim, staff confirm; PNG QR for WhatsApp', async (t) => {
  const s = await start();
  t.after(s.close);
  const menu = (await s.call('GET', '/api/menu?outletId=1')).body.flatMap((c) => c.items);
  const items = [{ id: menu.find((i) => i.name === 'Veg Fried Rice').id, qty: 2 }];
  const created = await s.call('POST', '/api/orders', { fulfilment: 'delivery', ...PLACES.sector22, items, name: 'Kiran', phone: '9876501234', address: 'House 1, Sector 22', paymentMethod: 'upi' });
  const { code } = created.body;

  const track = await s.call('GET', `/api/orders/${code}`);
  assert.equal(track.body.payment.status, 'pending');
  assert.match(track.body.payment.link, /^upi:\/\/pay\?pa=tk-sec-17-chd%40example&pn=Test%20Kitchen&am=\d+\.\d{2}&cu=INR/);
  assert.match(track.body.payment.qrSvg, /^<svg/);

  const png = await fetch(`${s.base}/pay/${code}/qr.png`);
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await png.arrayBuffer()).subarray(1, 4).toString(), 'PNG');

  const claimed = await s.call('POST', `/api/orders/${code}/paid`, {});
  assert.equal(claimed.body.payment.status, 'claimed');

  const live = await s.call('GET', '/api/admin/orders?outletId=1', undefined, admin);
  assert.equal(live.body[0].paymentLabel, 'Customer says paid, check UPI app');
  const paid = await s.call('POST', `/api/admin/orders/${code}/payment`, { status: 'paid' }, admin);
  assert.equal(paid.body.payment_status, 'paid');
  assert.equal((await s.call('POST', `/api/admin/orders/${code}/payment`, { status: 'pending' }, admin)).status, 400);
  // Web orders don't get WhatsApp messages.
  assert.equal(s.sent.length, 0);
});

test('Shadowfax: staff book from the dashboard; callbacks need the shared token', async (t) => {
  const s = await start();
  t.after(s.close);
  const menu = (await s.call('GET', '/api/menu?outletId=1')).body.flatMap((c) => c.items);
  const items = [{ id: menu.find((i) => i.name === 'Veg Fried Rice').id, qty: 2 }];
  const { code } = (await s.call('POST', '/api/orders', { fulfilment: 'delivery', ...PLACES.sector22, items, name: 'Kiran', phone: '9876501234', address: 'House 1, Sector 22' })).body;

  // No partner configured in tests: booking is recorded as failed, own rider works.
  const failed = await s.call('POST', `/api/admin/orders/${code}/delivery`, { action: 'book' }, admin);
  assert.equal(failed.body.delivery.status, 'FAILED');
  const own = await s.call('POST', `/api/admin/orders/${code}/delivery`, { action: 'own' }, admin);
  assert.equal(own.body.delivery.label, 'Outlet rider');
  assert.equal((await s.call('GET', `/api/orders/${code}`)).body.delivery.label, 'Outlet rider');

  const prev = config.shadowfax.callbackToken;
  config.shadowfax.callbackToken = 'cb-secret';
  t.after(() => { config.shadowfax.callbackToken = prev; });
  assert.equal((await s.call('POST', '/webhooks/shadowfax', { sfx_order_id: 'x', order_status: 'DELIVERED' })).status, 401);
  assert.equal((await s.call('PUT', '/webhooks/shadowfax', { sfx_order_id: 'x', order_status: 'DELIVERED' }, { 'X-Callback-Token': 'cb-secret' })).status, 200);
});

test('web start flow helpers: typed address to area, loyalty points by WhatsApp number', async (t) => {
  const s = await start();
  t.after(s.close);
  const g = await s.call('POST', '/api/geocode', { address: 'House 12, sec 22-B, Chandigarh' });
  assert.equal(g.body.place.name, 'Sector 22');
  assert.equal((await s.call('POST', '/api/geocode', { address: 'Green Valley Apartments' })).body.place, null);

  assert.equal((await s.call('GET', '/api/loyalty?phone=12')).status, 400);
  assert.equal((await s.call('GET', '/api/loyalty?phone=9876501234')).body.points, 0);
  const menu = (await s.call('GET', '/api/menu?outletId=1')).body.flatMap((c) => c.items);
  const items = [{ id: menu.find((i) => i.name === 'Chicken Fried Rice').id, qty: 4 }];
  const { code } = (await s.call('POST', '/api/orders', { fulfilment: 'pickup', outletId: 1, items, name: 'Kiran', phone: '9876501234', marketingOptIn: true })).body;
  for (const st of ['accepted', 'preparing', 'ready', 'completed']) await s.call('POST', `/api/admin/orders/${code}/status`, { status: st }, admin);
  const pts = (await s.call('GET', '/api/loyalty?phone=+91 98765 01234')).body.points;
  assert.ok(pts >= 6, `got ${pts}`);
  const track = (await s.call('GET', `/api/orders/${code}`)).body;
  assert.deepEqual(track.loyalty, { points: pts, earned: true });
  const crm = (await s.call('GET', '/api/admin/customers?optIn=1', undefined, admin)).body;
  assert.equal(crm.customers[0].phone, '+919876501234');
});
