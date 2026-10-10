'use strict';

// Sales analytics for the admin dashboard: KPIs with period-over-period
// change, daily trend, outlet-wise and item-wise sales, category mix, a
// weekday × hour heatmap, channel / payment / fulfilment splits, top
// customers and dishes that didn't sell. All dates are IST days.
//
// Sales exclude cancelled orders. "Gross sales" is what customers paid
// (items + packing + GST + delivery); "item sales" is the food alone.

const IST = 330 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

const istDay = (iso) => new Date(new Date(iso).getTime() + IST).toISOString().slice(0, 10);
const istStart = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - IST);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

function kpis(orders, firstOrderAt, fromIso) {
  const live = orders.filter((o) => o.status !== 'cancelled');
  const sum = (f) => live.reduce((t, o) => t + (f(o) || 0), 0);
  const phones = new Set(live.map((o) => o.phone));
  const newCustomers = [...phones].filter((p) => firstOrderAt.get(p) >= fromIso).length;
  const delivery = live.filter((o) => o.fulfilment === 'delivery');
  return {
    grossSales: sum((o) => o.total),
    itemSales: sum((o) => o.subtotal),
    orders: live.length,
    aov: live.length ? Math.round(sum((o) => o.total) / live.length) : 0,
    customers: phones.size,
    newCustomers,
    returningCustomers: phones.size - newCustomers,
    cancelled: orders.length - live.length,
    cancelRate: orders.length ? (orders.length - live.length) / orders.length : 0,
    gst: sum((o) => o.gst),
    packing: sum((o) => o.packing),
    deliveryFees: sum((o) => o.delivery_fee),
    deliveryOrders: delivery.length,
    pickupOrders: live.length - delivery.length,
    avgDeliveryKm: delivery.length ? Math.round((delivery.reduce((t, o) => t + (o.distance_km || 0), 0) / delivery.length) * 10) / 10 : 0,
    upiPaid: sum((o) => (o.payment_status === 'paid' ? o.total : 0)),
  };
}

function change(cur, prev) {
  const out = {};
  for (const k of Object.keys(cur)) out[k] = prev[k] ? (cur[k] - prev[k]) / Math.abs(prev[k]) : null;
  return out;
}

/**
 * filters: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' (inclusive), outletId?, channel?, fulfilment? }
 */
function computeAnalytics(store, filters = {}, now = new Date()) {
  const today = istDay(now.toISOString());
  const to = filters.to || today;
  const from = filters.from || addDays(to, -29);
  const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1);
  const prevFrom = addDays(from, -days);
  const fromIso = istStart(from).toISOString();
  const toIso = istStart(addDays(to, 1)).toISOString();
  const prevIso = istStart(prevFrom).toISOString();

  const outlets = new Map(store.outlets().map((o) => [o.id, o]));
  const menu = new Map(store.allMenuItems().map((i) => [i.id, i]));
  const match = (o) => (!filters.outletId || o.outlet_id === Number(filters.outletId))
    && (!filters.channel || o.channel === filters.channel)
    && (!filters.fulfilment || o.fulfilment === filters.fulfilment);

  // Only this period and the one before it; first-order dates come from the database.
  const all = store.ordersBetween(prevIso, toIso);
  const firstOrderAt = store.firstOrders(prevIso, toIso);

  // UPI orders that were never paid never reached the kitchen: not orders at all here.
  const real = (o) => o.status !== 'awaiting_payment' && o.status !== 'unpaid';
  const cur = all.filter((o) => o.created_at >= fromIso && o.created_at < toIso && match(o) && real(o));
  const prev = all.filter((o) => o.created_at >= prevIso && o.created_at < fromIso && match(o) && real(o));
  const live = cur.filter((o) => o.status !== 'cancelled');
  const liveIds = new Set(live.map((o) => o.id));
  const lines = store.linesBetween(fromIso, toIso).filter((l) => liveIds.has(l.order_id));

  const summary = kpis(cur, firstOrderAt, fromIso);
  const previous = kpis(prev, firstOrderAt, prevIso);

  // Daily trend (every day in range, zeros included).
  const daily = new Map();
  for (let d = from; d <= to; d = addDays(d, 1)) daily.set(d, { date: d, sales: 0, orders: 0 });
  for (const o of live) {
    const d = daily.get(istDay(o.created_at));
    if (d) { d.sales += o.total; d.orders += 1; }
  }

  // Outlets.
  const byOutlet = new Map([...outlets.keys()].map((id) => [id, { outletId: id, name: outlets.get(id).name, orders: 0, sales: 0, cancelled: 0, itemsSold: 0, delivery: 0 }]));
  for (const o of cur) {
    const r = byOutlet.get(o.outlet_id);
    if (!r) continue;
    if (o.status === 'cancelled') { r.cancelled += 1; continue; }
    r.orders += 1;
    r.sales += o.total;
    if (o.fulfilment === 'delivery') r.delivery += 1;
  }
  const orderOutlet = new Map(live.map((o) => [o.id, o.outlet_id]));
  for (const l of lines) { const r = byOutlet.get(orderOutlet.get(l.order_id)); if (r) r.itemsSold += l.qty; }
  const outletRows = [...byOutlet.values()]
    .filter((r) => !filters.outletId || r.outletId === Number(filters.outletId))
    .map((r) => ({ ...r, aov: r.orders ? Math.round(r.sales / r.orders) : 0, share: summary.grossSales ? r.sales / summary.grossSales : 0 }))
    .sort((a, b) => b.sales - a.sales);

  // Items and categories.
  const items = new Map();
  for (const l of lines) {
    const m = menu.get(l.item_id);
    const r = items.get(l.item_id) || { itemId: l.item_id, name: m?.name || l.name, category: m?.category || '—', veg: !!m?.veg, qty: 0, revenue: 0, orders: new Set(), price: m?.price ?? l.price };
    r.qty += l.qty;
    r.revenue += l.price * l.qty;
    r.orders.add(l.order_id);
    items.set(l.item_id, r);
  }
  const itemTotal = [...items.values()].reduce((t, r) => t + r.revenue, 0);
  const itemRows = [...items.values()]
    .map((r) => ({ ...r, orders: r.orders.size, share: itemTotal ? r.revenue / itemTotal : 0, attachRate: live.length ? r.orders.size / live.length : 0 }))
    .sort((a, b) => b.revenue - a.revenue)
    .map((r, i) => ({ ...r, rank: i + 1 }));
  const categories = new Map();
  for (const r of itemRows) {
    const c = categories.get(r.category) || { category: r.category, qty: 0, revenue: 0 };
    c.qty += r.qty;
    c.revenue += r.revenue;
    categories.set(r.category, c);
  }
  const notSold = [...menu.values()].filter((m) => m.active && !items.has(m.id)).map((m) => ({ itemId: m.id, name: m.name, category: m.category, price: m.price }));

  // Weekday × hour heatmap (IST). 0 = Monday.
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const o of live) {
    const t = new Date(new Date(o.created_at).getTime() + IST);
    heat[(t.getUTCDay() + 6) % 7][t.getUTCHours()] += 1;
  }

  const split = (key, labels) => {
    const m = new Map();
    for (const o of live) {
      const k = key(o);
      const r = m.get(k) || { key: k, label: labels[k] || k, orders: 0, sales: 0 };
      r.orders += 1;
      r.sales += o.total;
      m.set(k, r);
    }
    return [...m.values()].sort((a, b) => b.sales - a.sales);
  };

  // ---- Rush timings --------------------------------------------------------
  const hourOf = (iso) => new Date(new Date(iso).getTime() + IST).getUTCHours();
  const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: 0, sales: 0 }));
  for (const o of live) { const h = hourly[hourOf(o.created_at)]; h.orders += 1; h.sales += o.total; }
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const slots = [];
  heat.forEach((row, d) => row.forEach((n, h) => { if (n) slots.push({ day: WEEKDAYS[d], hour: h, orders: n }); }));
  slots.sort((a, b) => b.orders - a.orders);
  const outletPeaks = outletRows.map((r) => {
    const hrs = Array(24).fill(0);
    for (const o of live) if (o.outlet_id === r.outletId) hrs[hourOf(o.created_at)] += 1;
    const peak = hrs.indexOf(Math.max(...hrs));
    return { outletId: r.outletId, name: r.name, peakHour: hrs[peak] ? peak : null, peakOrders: hrs[peak] };
  });

  // Speed: minutes between status changes (needs the order_events history).
  const ev = new Map();
  for (const e of store.orderEventsBetween(fromIso, toIso)) {
    if (!liveIds.has(e.order_id)) continue;
    const m = ev.get(e.order_id) || {};
    m[e.status] = m[e.status] || e.at;
    ev.set(e.order_id, m);
  }
  const mins = (a, b) => (a && b ? (new Date(b) - new Date(a)) / 60000 : null);
  const avg = (xs) => { const v = xs.filter((x) => x != null && x >= 0); return v.length ? Math.round((v.reduce((t, x) => t + x, 0) / v.length) * 10) / 10 : null; };
  const timing = [];
  for (const o of live) {
    const m = ev.get(o.id);
    if (!m) continue;
    const ready = m.ready || m.out_for_delivery;
    timing.push({
      hour: hourOf(o.created_at), outletId: o.outlet_id, fulfilment: o.fulfilment,
      accept: mins(m.placed, m.accepted), prep: mins(m.accepted, ready), ride: mins(m.out_for_delivery, m.completed), total: mins(m.placed, m.completed),
    });
  }
  const speed = {
    measured: timing.length,
    acceptMin: avg(timing.map((x) => x.accept)),
    prepMin: avg(timing.map((x) => x.prep)),
    rideMin: avg(timing.filter((x) => x.fulfilment === 'delivery').map((x) => x.ride)),
    totalDeliveryMin: avg(timing.filter((x) => x.fulfilment === 'delivery').map((x) => x.total)),
    byHour: hourly.map((h) => ({ hour: h.hour, orders: h.orders, prepMin: avg(timing.filter((x) => x.hour === h.hour).map((x) => x.prep)), totalMin: avg(timing.filter((x) => x.hour === h.hour && x.fulfilment === 'delivery').map((x) => x.total)) })),
    byOutlet: outletRows.map((r) => ({ outletId: r.outletId, name: r.name, prepMin: avg(timing.filter((x) => x.outletId === r.outletId).map((x) => x.prep)), totalMin: avg(timing.filter((x) => x.outletId === r.outletId && x.fulfilment === 'delivery').map((x) => x.total)) })),
  };

  // ---- Combinations: dishes ordered together --------------------------------
  const byOrder = new Map();
  for (const l of lines) {
    const s = byOrder.get(l.order_id) || new Map();
    s.set(l.item_id, (s.get(l.item_id) || 0) + l.price * l.qty);
    byOrder.set(l.order_id, s);
  }
  const pairs = new Map();
  for (const s of byOrder.values()) {
    const ids = [...s.keys()].sort((a, b) => a - b);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const k = `${ids[i]}-${ids[j]}`;
        const p = pairs.get(k) || { a: ids[i], b: ids[j], orders: 0, revenue: 0 };
        p.orders += 1;
        p.revenue += s.get(ids[i]) + s.get(ids[j]);
        pairs.set(k, p);
      }
    }
  }
  const qtyOrders = new Map(itemRows.map((r) => [r.itemId, r.orders]));
  const nameOf = (id) => menu.get(id)?.name || items.get(id)?.name || `#${id}`;
  const combinations = [...pairs.values()]
    .filter((p) => p.orders >= 2)
    .sort((x, y) => y.orders - x.orders)
    .slice(0, 20)
    .map((p) => ({
      items: [nameOf(p.a), nameOf(p.b)], itemIds: [p.a, p.b], orders: p.orders, revenue: p.revenue,
      share: live.length ? p.orders / live.length : 0,
      // How often people who order A also take B (and the other way round).
      withA: qtyOrders.get(p.a) ? p.orders / qtyOrders.get(p.a) : 0,
      withB: qtyOrders.get(p.b) ? p.orders / qtyOrders.get(p.b) : 0,
    }));

  // ---- Reviews (WhatsApp star ratings) ---------------------------------------
  const ratings = store.ratingsBetween(fromIso, toIso).filter((r) => liveIds.has(r.order_id));
  const overallBy = new Map(ratings.filter((r) => r.item_id === 0).map((r) => [r.order_id, r.stars]));
  const mean = (xs) => (xs.length ? Math.round((xs.reduce((t, x) => t + x, 0) / xs.length) * 100) / 100 : null);
  const completedCount = live.filter((o) => o.status === 'completed').length;
  const itemStars = new Map();
  for (const r of ratings) {
    if (r.item_id === 0) continue;
    const x = itemStars.get(r.item_id) || { itemId: r.item_id, name: menu.get(r.item_id)?.name || r.name, stars: [] };
    x.stars.push(r.stars);
    itemStars.set(r.item_id, x);
  }
  const comments = store.commentsBetween(fromIso, toIso).filter((c) => liveIds.has(c.order_id));
  const orderById = new Map(live.map((o) => [o.id, o]));
  const reviews = {
    count: overallBy.size,
    responseRate: completedCount ? overallBy.size / completedCount : 0,
    average: mean([...overallBy.values()]),
    distribution: [5, 4, 3, 2, 1].map((n) => ({ stars: n, count: [...overallBy.values()].filter((s) => s === n).length })),
    byOutlet: outletRows.map((r) => {
      const s = [...overallBy].filter(([id]) => orderById.get(id)?.outlet_id === r.outletId).map(([, v]) => v);
      return { outletId: r.outletId, name: r.name, average: mean(s), count: s.length };
    }),
    byItem: [...itemStars.values()].map((x) => ({ itemId: x.itemId, name: x.name, average: mean(x.stars), count: x.stars.length, low: x.stars.filter((s) => s <= 2).length }))
      .sort((a, b) => b.count - a.count),
    comments: comments.map((c) => {
      const o = orderById.get(c.order_id);
      return { code: o?.code, outletId: o?.outlet_id, name: o?.customer_name, stars: overallBy.get(c.order_id) ?? null, comment: c.comment, at: c.at };
    }).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 30),
  };
  // Combination ratings: average whole-order stars of rated orders containing both dishes.
  for (const c of combinations) {
    const s = [];
    for (const [orderId, stars] of overallBy) {
      const set = byOrder.get(orderId);
      if (set && set.has(c.itemIds[0]) && set.has(c.itemIds[1])) s.push(stars);
    }
    c.rating = mean(s);
    c.ratings = s.length;
  }

  const customers = new Map();
  for (const o of live) {
    const r = customers.get(o.phone) || { phone: o.phone, name: o.customer_name, orders: 0, spent: 0 };
    r.orders += 1;
    r.spent += o.total;
    customers.set(o.phone, r);
  }

  return {
    range: { from, to, days, previous: { from: prevFrom, to: addDays(from, -1) } },
    summary,
    previous,
    change: change(summary, previous),
    daily: [...daily.values()],
    outlets: outletRows,
    items: itemRows,
    categories: [...categories.values()].map((c) => ({ ...c, share: itemTotal ? c.revenue / itemTotal : 0 })).sort((a, b) => b.revenue - a.revenue),
    notSold,
    heatmap: heat,
    channels: split((o) => o.channel, { web: 'Web app', whatsapp: 'WhatsApp' }),
    payments: split((o) => (o.payment_method === 'upi' ? (o.payment_status === 'paid' ? 'upi_paid' : 'upi_unconfirmed') : 'cod'), { upi_paid: 'UPI (paid)', upi_unconfirmed: 'UPI (not yet confirmed)', cod: 'Cash/UPI on delivery' }),
    fulfilment: split((o) => o.fulfilment, { delivery: 'Delivery', pickup: 'Pickup' }),
    topCustomers: [...customers.values()].sort((a, b) => b.spent - a.spent).slice(0, 10),
    rush: { hourly, busiestSlots: slots.slice(0, 8), outletPeaks },
    reviews,
    speed,
    combinations,
  };
}

module.exports = { computeAnalytics, istDay, addDays };
