'use strict';

// CRM and loyalty.
//
// Every incoming order (web or WhatsApp) saves or updates the customer's
// profile, keyed by phone number. Order stats are computed from the orders
// themselves, so they never drift. Loyalty: 1 point per ₹100 of a completed
// order's total (configurable), credited once per order; staff can redeem or
// adjust points with a reason, and every change is kept in a ledger.

const { EventEmitter } = require('node:events');
const config = require('./config');
const { normalisePhone, ValidationError, NOT_SALES } = require('./orders');

const DAY = 24 * 60 * 60 * 1000;

const SEGMENTS = {
  new: 'New (1 order)',
  regular: 'Regular (3+ orders)',
  vip: 'VIP (top spenders)',
  lapsed: 'Lapsed (no order in 30 days)',
  all: 'All customers',
};

function pointsFor(totalPaise) {
  return Math.floor(totalPaise / (config.loyalty.rupeesPerPoint * 100));
}

function createCrm({ store, orders }) {
  const events = new EventEmitter();

  // Save the customer from every new order.
  orders.events.on('created', (o) => {
    const cur = store.customer(o.phone);
    store.upsertCustomer({
      phone: o.phone,
      name: o.customer_name && o.customer_name !== 'WhatsApp customer' ? o.customer_name : cur?.name || o.customer_name,
      first_seen_at: cur?.first_seen_at || o.created_at,
      last_seen_at: o.created_at,
      first_channel: cur?.first_channel || o.channel,
      last_address: o.address || cur?.last_address || null,
      last_lat: o.lat ?? cur?.last_lat ?? null,
      last_lng: o.lng ?? cur?.last_lng ?? null,
      last_outlet_id: o.outlet_id,
      // Opt-in is only ever switched on by the customer (checkbox / WhatsApp) or staff, never off by an order.
      marketing_opt_in: o.marketingOptIn ? 1 : cur?.marketing_opt_in ?? 0,
    });
  });

  // Credit points when an order completes.
  orders.events.on('status', (o) => {
    if (o.status !== 'completed') return;
    const points = pointsFor(o.total);
    if (points > 0 && store.addPoints({ phone: o.phone, orderId: o.id, points, kind: 'earn', note: `Order ${o.code}`, at: new Date().toISOString() })) {
      events.emit('points', { order: o, points, balance: balance(o.phone) });
    }
  });

  const balance = (raw) => store.pointsBalance(normalisePhone(raw) || raw);
  const optedIn = (phone) => !!store.customer(normalisePhone(phone) || phone)?.marketing_opt_in;

  function rowFor(c, s, points, now) {
    s ||= { orders: 0, spent: 0, last: c.last_seen_at, first: c.first_seen_at, outletId: null };
    return {
      phone: c.phone, name: c.name, firstChannel: c.first_channel, address: c.last_address,
      orders: s.orders, spent: s.spent, avgOrder: s.orders ? Math.round(s.spent / s.orders) : 0,
      firstOrderAt: s.first, lastOrderAt: s.last, daysSinceLast: s.last ? Math.floor((now - new Date(s.last)) / DAY) : null,
      outletId: s.outletId ?? c.last_outlet_id, points,
      optIn: !!c.marketing_opt_in, tags: c.tags ? c.tags.split(',').filter(Boolean) : [], notes: c.notes,
    };
  }
  const segmentsFor = (r, vipCut) => [
    r.orders === 1 && 'new',
    r.orders >= 3 && 'regular',
    r.orders >= 2 && r.spent >= vipCut && 'vip',
    r.daysSinceLast != null && r.daysSinceLast > 30 && 'lapsed',
  ].filter(Boolean);

  /** Customers with live stats. Cancelled orders don't count. */
  function list({ q, segment = 'all', outletId, optIn, sort = 'last', limit = 500, now = new Date() } = {}) {
    // Totals per customer come from the database in one pass (fast with a year of orders).
    const byPhone = store.customerStats();
    const balances = store.pointsBalances();
    let rows = store.customers().map((c) => rowFor(c, byPhone.get(c.phone), balances.get(c.phone) || 0, now));
    // VIP = top 10% by spend (at least 1 customer, with 2+ orders).
    const spends = rows.filter((r) => r.orders >= 2).map((r) => r.spent).sort((a, b) => b - a);
    const vipCut = spends.length ? spends[Math.max(0, Math.ceil(spends.length * 0.1) - 1)] : Infinity;
    for (const r of rows) r.segments = segmentsFor(r, vipCut);
    const counts = Object.fromEntries(Object.keys(SEGMENTS).map((k) => [k, k === 'all' ? rows.length : rows.filter((r) => r.segments.includes(k)).length]));

    if (segment && segment !== 'all') rows = rows.filter((r) => r.segments.includes(segment));
    if (outletId) rows = rows.filter((r) => r.outletId === Number(outletId));
    if (optIn) rows = rows.filter((r) => r.optIn);
    if (q) {
      const needle = String(q).toLowerCase();
      rows = rows.filter((r) => (r.name || '').toLowerCase().includes(needle) || r.phone.includes(needle.replace(/\D/g, '') || '~'));
    }
    const sorters = {
      last: (a, b) => String(b.lastOrderAt).localeCompare(String(a.lastOrderAt)),
      spent: (a, b) => b.spent - a.spent,
      orders: (a, b) => b.orders - a.orders,
      points: (a, b) => b.points - a.points,
    };
    rows.sort(sorters[sort] || sorters.last);
    return { total: rows.length, counts, segments: SEGMENTS, customers: rows.slice(0, Math.min(Number(limit) || 500, 5000)) };
  }

  function get(rawPhone) {
    const phone = normalisePhone(rawPhone) || rawPhone;
    const c = store.customer(phone);
    if (!c) return null;
    // One customer's figures straight from the database, not the whole list.
    const row = rowFor(c, store.customerStatsFor(phone), balance(phone), new Date());
    row.segments = segmentsFor(row, store.vipCutoff());
    const history = store.ordersForPhone(phone).slice(0, 50).map((o) => ({
      code: o.code, at: o.created_at, total: o.total, status: o.status, outletId: o.outlet_id, channel: o.channel,
      items: store.orderLines(o.id).map((l) => `${l.qty}× ${l.name}`).join(', '),
    }));
    // Favourite dishes across all orders.
    const fav = new Map();
    for (const o of store.ordersForPhone(phone)) {
      if (NOT_SALES.includes(o.status)) continue;
      for (const l of store.orderLines(o.id)) fav.set(l.name, (fav.get(l.name) || 0) + l.qty);
    }
    return {
      ...row, history, ledger: store.pointsLedger(phone),
      favourites: [...fav].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, qty]) => ({ name, qty })),
    };
  }

  /** Staff redeem (negative) or adjust points. Can't go below zero. */
  function adjustPoints(rawPhone, delta, note, kind = 'adjust') {
    const phone = normalisePhone(rawPhone) || rawPhone;
    if (!store.customer(phone)) return null;
    const points = Math.trunc(Number(delta));
    if (!points) throw new ValidationError('Enter a non-zero number of points.');
    if (balance(phone) + points < 0) throw new ValidationError(`Only ${balance(phone)} points available.`);
    store.addPoints({ phone, points, kind: points < 0 ? (kind === 'adjust' ? 'redeem' : kind) : kind, note: note || null, at: new Date().toISOString() });
    events.emit('points', { phone, points, balance: balance(phone), manual: true });
    return get(phone);
  }

  function update(rawPhone, { optIn, tags, notes, name }) {
    const phone = normalisePhone(rawPhone) || rawPhone;
    if (!store.customer(phone)) return null;
    store.upsertCustomer({
      phone,
      ...(optIn !== undefined ? { marketing_opt_in: optIn ? 1 : 0 } : {}),
      ...(tags !== undefined ? { tags: (Array.isArray(tags) ? tags : String(tags).split(',')).map((t) => t.trim()).filter(Boolean).join(',') } : {}),
      ...(notes !== undefined ? { notes: String(notes).slice(0, 1000) } : {}),
      ...(name ? { name: String(name).slice(0, 80) } : {}),
    });
    return get(phone);
  }

  /** Campaign list as CSV (respecting the same filters). */
  function exportCsv(filters) {
    const cell = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
    const head = ['name', 'phone', 'orders', 'total_spent_rs', 'avg_order_rs', 'points', 'last_order', 'days_since_last', 'segments', 'marketing_opt_in', 'tags', 'address'];
    const rows = list({ ...filters, limit: 5000 }).customers.map((r) => [
      r.name, r.phone, r.orders, (r.spent / 100).toFixed(2), (r.avgOrder / 100).toFixed(2), r.points, r.lastOrderAt, r.daysSinceLast,
      r.segments.join(' '), r.optIn ? 'yes' : 'no', r.tags.join(' '), r.address,
    ]);
    return [head, ...rows].map((r) => r.map(cell).join(',')).join('\n') + '\n';
  }

  /** For WhatsApp: balance and the last few point changes. */
  const pointsSummary = (raw) => {
    const phone = normalisePhone(raw) || raw;
    return store.customer(phone) ? { points: balance(phone), ledger: store.pointsLedger(phone).slice(0, 3) } : null;
  };

  return { events, list, get, balance, optedIn, pointsSummary, adjustPoints, update, exportCsv, pointsFor, SEGMENTS };
}

module.exports = { createCrm, pointsFor };
