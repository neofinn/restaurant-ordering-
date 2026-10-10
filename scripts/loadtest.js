'use strict';

// Load test against a running server: simulated web customers, WhatsApp
// conversations, outlet tablets polling, and staff moving orders along.
//
//   node scripts/loadtest.js http://localhost:3000 --seconds 60 --customers 40
//
// Each virtual customer loops: browse menu, quote, place an order, track it.
// Every 4th customer orders on WhatsApp (8 webhook messages) instead.
// 7 tablets poll their outlet's orders every 5 s, like the real outlet panel.
// Prints orders/minute achieved and latency percentiles per request type.
// Run against a scratch database (DB_PATH) with no WHATSAPP_APP_SECRET set.

const base = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const SECONDS = arg('seconds', 30);
const CUSTOMERS = arg('customers', 20);
const ADMIN = process.env.ADMIN_TOKEN || 'change-me';

const stats = new Map();
let errors = 0;
const errorSamples = [];
async function call(kind, method, path, body, token) {
  const t = performance.now();
  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const ms = performance.now() - t;
    (stats.get(kind) || stats.set(kind, []).get(kind)).push(ms);
    if (res.status >= 400) {
      errors += 1;
      if (errorSamples.length < 5) errorSamples.push(`${kind} ${res.status} ${text.slice(0, 120)}`);
    }
    try { return JSON.parse(text); } catch { return text; }
  } catch (e) {
    errors += 1;
    if (errorSamples.length < 5) errorSamples.push(`${kind} ${e.message}`);
    return null;
  }
}

// Spots across the sample client's area (lat, lng); change them for another city.
const SPOTS = [[30.733, 76.772], [30.7085, 76.7195], [30.694, 76.86], [30.642, 76.817], [30.746, 76.645], [30.76, 76.78], [30.7, 76.79]];
const rnd = (n) => Math.floor(Math.random() * n);

let menu = [];
let orders = 0;
const placed = [];
const end = Date.now() + SECONDS * 1000;

async function webCustomer() {
  while (Date.now() < end) {
    const [lat, lng] = SPOTS[rnd(SPOTS.length)];
    await call('outlets', 'GET', '/api/outlets');
    const loc = await call('locate', 'POST', '/api/locate', { lat, lng });
    if (!loc || !loc.outlet) continue;
    await call('menu', 'GET', `/api/menu?outletId=${loc.outlet.id}`);
    const items = [{ id: menu[rnd(menu.length)].id, qty: 1 + rnd(2) }, { id: menu[rnd(menu.length)].id, qty: 1 }];
    await call('quote', 'POST', '/api/quote', { fulfilment: 'delivery', lat, lng, items });
    const o = await call('order', 'POST', '/api/orders', {
      fulfilment: 'delivery', lat, lng, items, name: 'Load Test', phone: `98${String(rnd(1e8)).padStart(8, '0')}`, address: 'House 1, Sector 22, Chandigarh',
    });
    if (o && o.code) { orders += 1; placed.push(o.code); }
    for (let i = 0; i < 3 && o && o.code; i++) await call('track', 'GET', `/api/orders/${o.code}`);
  }
}

let msgId = 0;
const wa = (from, m) => ({ entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name: 'Load' } }], messages: [{ id: `wamid.load${++msgId}`, from, timestamp: String(Math.floor(Date.now() / 1000)), ...m }] } }] }] });
const reply = (id) => ({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: id } } });

async function whatsappCustomer() {
  while (Date.now() < end) {
    const from = `9198${String(rnd(1e8)).padStart(8, '0')}`;
    const [lat, lng] = SPOTS[rnd(SPOTS.length)];
    const steps = [
      { type: 'text', text: { body: 'hi' } },
      reply('mode:delivery'),
      { type: 'location', location: { latitude: lat, longitude: lng } },
      { type: 'text', text: { body: 'House 7, Sector 22, near market' } },
      { type: 'text', text: { body: '2 half kurkure veg momo less spicy, 1 full veg hakka noodles no onion' } },
      reply('act:checkout'),
      reply('act:place'),
      { type: 'text', text: { body: 'track' } },
    ];
    for (const s of steps) await call('whatsapp', 'POST', '/webhooks/whatsapp', wa(from, s));
    orders += 1; // counted optimistically; the order count in the DB is the truth
  }
}

async function tablet(token) {
  while (Date.now() < end) {
    await call('tablet', 'GET', '/api/outlet/orders', undefined, token);
    await call('tablet', 'GET', '/api/outlet/chats', undefined, token);
    await call('tablet', 'GET', '/api/outlet/summary', undefined, token);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function staff() {
  // Accept and cook; the (simulated) delivery partner moves the order on from there.
  const next = ['accepted', 'preparing'];
  const stage = new Map();
  while (Date.now() < end) {
    const code = placed[rnd(placed.length || 1)];
    if (code) {
      const s = stage.get(code) || 0;
      if (s < next.length) {
        await call('status', 'POST', `/api/admin/orders/${code}/status`, { status: next[s] }, ADMIN);
        stage.set(code, s + 1);
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

const pct = (a, p) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];

async function main() {
  const cats = await call('setup', 'GET', '/api/menu');
  menu = cats.flatMap((c) => c.items);
  const outlets = await call('setup', 'GET', '/api/admin/outlets', undefined, ADMIN);
  const tokens = [];
  for (const o of outlets) {
    // Open around the clock for the test, and give each outlet a panel PIN.
    await call('setup', 'PATCH', `/api/admin/outlets/${o.id}`, { opens: '00:00', closes: '00:00' }, ADMIN);
    await call('setup', 'POST', `/api/admin/outlets/${o.id}/pin`, { pin: '4321' }, ADMIN);
    const login = await call('setup', 'POST', '/api/outlet/login', { outletId: o.id, pin: '4321' });
    tokens.push(login.token);
  }
  stats.clear(); errors = 0; errorSamples.length = 0;
  const started = Date.now();
  const web = Math.ceil(CUSTOMERS * 0.75);
  await Promise.all([
    ...Array.from({ length: web }, webCustomer),
    ...Array.from({ length: CUSTOMERS - web }, whatsappCustomer),
    ...tokens.map(tablet),
    staff(),
  ]);
  const secs = (Date.now() - started) / 1000;
  const all = [...stats.values()].flat().sort((a, b) => a - b);
  console.log(`${CUSTOMERS} concurrent customers for ${secs.toFixed(0)} s: ${orders} orders (${Math.round((orders / secs) * 60)} per minute, ${Math.round((orders / secs) * 3600)} per hour)`);
  console.log(`${all.length} requests (${Math.round(all.length / secs)}/s), ${errors} errors; latency p50 ${pct(all, 50).toFixed(0)} ms, p95 ${pct(all, 95).toFixed(0)} ms, p99 ${pct(all, 99).toFixed(0)} ms`);
  for (const [k, v] of stats) {
    v.sort((a, b) => a - b);
    console.log(`  ${k.padEnd(9)} n=${String(v.length).padStart(6)}  p50 ${pct(v, 50).toFixed(1).padStart(6)} ms  p95 ${pct(v, 95).toFixed(1).padStart(6)} ms  max ${v[v.length - 1].toFixed(0).padStart(5)} ms`);
  }
  if (errorSamples.length) console.log('Sample errors:\n  ' + errorSamples.join('\n  '));
}

main();
