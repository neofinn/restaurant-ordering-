'use strict';

// Data access for the server, backed by SQLite (node:sqlite). The browser demo
// implements the same interface in memory (src/store/memory.js), so the order,
// handoff and WhatsApp logic run unchanged in both.

const DELIVERY_COLS = ['provider', 'ref', 'status', 'rider_name', 'rider_phone', 'rider_lat', 'rider_lng', 'track_url', 'error',
  'price', 'booked_at', 'allotted_at', 'tried', 'quotes', 'updated_at'];

function createSqliteStore(db) {
  const q = {
    outlets: db.prepare('SELECT * FROM outlets WHERE active = 1 ORDER BY id'),
    outlet: db.prepare('SELECT * FROM outlets WHERE id = ?'),
    setAccepting: db.prepare('UPDATE outlets SET accepting_orders = ? WHERE id = ?'),
    allOutlets: db.prepare('SELECT * FROM outlets ORDER BY id'),
    insertOutlet: db.prepare(`INSERT INTO outlets
      (slug, name, city, address, lat, lng, phone, delivery_radius_km, opens, closes, upi_id, upi_name, sfx_store_code, wa_payment_config, accepting_orders, active)
      VALUES (@slug, @name, @city, @address, @lat, @lng, @phone, @delivery_radius_km, @opens, @closes, @upi_id, @upi_name, @sfx_store_code, @wa_payment_config, @accepting_orders, @active)`),
    items: db.prepare('SELECT * FROM menu_items WHERE active = 1 ORDER BY sort'),
    unavailable: db.prepare('SELECT item_id FROM outlet_unavailable_items WHERE outlet_id = ?'),
    stock: db.prepare('SELECT item_id, remaining, updated_at FROM outlet_stock WHERE outlet_id = ?'),
    allStock: db.prepare('SELECT outlet_id, item_id, remaining, updated_at FROM outlet_stock'),
    allUnavailable: db.prepare('SELECT outlet_id, item_id FROM outlet_unavailable_items'),
    setStock: db.prepare(`INSERT INTO outlet_stock (outlet_id, item_id, remaining, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (outlet_id, item_id) DO UPDATE SET remaining = excluded.remaining, updated_at = excluded.updated_at`),
    clearStock: db.prepare('DELETE FROM outlet_stock WHERE outlet_id = ? AND item_id = ?'),
    adjustStock: db.prepare('UPDATE outlet_stock SET remaining = MAX(0, remaining + ?), updated_at = ? WHERE outlet_id = ? AND item_id = ?'),
    pinHash: db.prepare('SELECT pin_hash, updated_at FROM outlet_logins WHERE outlet_id = ?'),
    logins: db.prepare('SELECT outlet_id, updated_at FROM outlet_logins'),
    paymentLinks: db.prepare('SELECT * FROM payment_links WHERE order_id = ? ORDER BY created_at, rowid'),
    paymentLinkById: db.prepare('SELECT * FROM payment_links WHERE id = ?'),
    insertPaymentLink: db.prepare(`INSERT INTO payment_links (id, order_id, provider, kind, url, amount, expires_at, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    refundsDue: db.prepare(`SELECT DISTINCT o.code FROM payment_links l JOIN orders o ON o.id = l.order_id
      WHERE l.status = 'paid' AND l.payment_id IS NOT NULL AND o.status = 'cancelled' AND o.payment_status = 'paid'`),
    openPaymentLinks: db.prepare("SELECT id, order_id, provider, kind, amount FROM payment_links WHERE status = 'created' AND created_at >= ?"),
    updatePaymentLink: db.prepare('UPDATE payment_links SET status = ?, payment_id = COALESCE(?, payment_id), refund_id = COALESCE(?, refund_id), updated_at = ? WHERE id = ?'),
    allSettings: db.prepare('SELECT key, value, secret, updated_at, updated_by FROM app_settings'),
    setSetting: db.prepare(`INSERT INTO app_settings (key, value, secret, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, secret = excluded.secret, updated_at = excluded.updated_at, updated_by = excluded.updated_by`),
    deleteSetting: db.prepare('DELETE FROM app_settings WHERE key = ?'),
    addSettingsLog: db.prepare('INSERT INTO settings_log (at, by, integration, change) VALUES (?, ?, ?, ?)'),
    settingsLog: db.prepare('SELECT at, by, integration, change FROM settings_log ORDER BY id DESC LIMIT ?'),
    gatewayEventSeen: db.prepare('INSERT OR IGNORE INTO gateway_events (event_id, at) VALUES (?, ?)'),
    unpaidBefore: db.prepare("SELECT code FROM orders WHERE status = 'awaiting_payment' AND payment_status = 'pending' AND created_at < ?"),
    setPin: db.prepare(`INSERT INTO outlet_logins (outlet_id, pin_hash, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (outlet_id) DO UPDATE SET pin_hash = excluded.pin_hash, updated_at = excluded.updated_at`),
    addSession: db.prepare('INSERT INTO staff_sessions (token_hash, outlet_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
    session: db.prepare('SELECT * FROM staff_sessions WHERE token_hash = ? AND expires_at > ?'),
    dropSession: db.prepare('DELETE FROM staff_sessions WHERE token_hash = ?'),
    dropSessions: db.prepare('DELETE FROM staff_sessions WHERE outlet_id = ?'),
    sessionCounts: db.prepare('SELECT outlet_id, COUNT(*) AS n, MAX(created_at) AS last FROM staff_sessions WHERE expires_at > ? GROUP BY outlet_id'),
    markOut: db.prepare('INSERT OR IGNORE INTO outlet_unavailable_items (outlet_id, item_id) VALUES (?, ?)'),
    markIn: db.prepare('DELETE FROM outlet_unavailable_items WHERE outlet_id = ? AND item_id = ?'),
    localities: db.prepare('SELECT name, city, lat, lng FROM localities ORDER BY city, id'),

    insertOrder: db.prepare(`INSERT INTO orders (code, outlet_id, channel, fulfilment, customer_name, phone,
      address, lat, lng, distance_km, notes, subtotal, packing, gst, delivery_fee, total, payment_method,
      payment_status, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertLine: db.prepare('INSERT INTO order_items (order_id, item_id, name, price, qty, note) VALUES (?, ?, ?, ?, ?, ?)'),
    byCode: db.prepare('SELECT * FROM orders WHERE code = ?'),
    lines: db.prepare('SELECT item_id, name, price, qty, note FROM order_items WHERE order_id = ? ORDER BY rowid'),
    latestForPhone: db.prepare('SELECT * FROM orders WHERE phone = ? ORDER BY id DESC LIMIT 1'),
    setStatus: db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ? AND status = ?'),
    setPayment: db.prepare('UPDATE orders SET payment_status = ?, updated_at = ? WHERE id = ? AND payment_status = ?'),
    byId: db.prepare('SELECT * FROM orders WHERE id = ?'),
    getDelivery: db.prepare('SELECT * FROM deliveries WHERE order_id = ?'),
    upsertDelivery: db.prepare(`INSERT INTO deliveries (order_id, ${DELIVERY_COLS.join(', ')}) VALUES (?, ${DELIVERY_COLS.map(() => '?').join(', ')})
      ON CONFLICT(order_id) DO UPDATE SET ${DELIVERY_COLS.map((c) => `${c} = excluded.${c}`).join(', ')}`),
    deliveryStats: db.prepare(`SELECT provider, COUNT(*) AS booked,
      SUM(CASE WHEN status IN ('FAILED', 'CANCELLED', 'UNDELIVERED') THEN 1 ELSE 0 END) AS failed,
      AVG(CASE WHEN allotted_at IS NOT NULL THEN (julianday(allotted_at) - julianday(booked_at)) * 1440 END) AS assign_min
      FROM deliveries WHERE booked_at >= ? GROUP BY provider`),
    staleDeliveries: db.prepare(`SELECT * FROM deliveries WHERE status IN ('BOOKING', 'ACCEPTED', 'UNASSIGNED') AND booked_at < ?`),
    deliveryByRef: db.prepare('SELECT * FROM deliveries WHERE ref = ? ORDER BY updated_at DESC LIMIT 1'),
    // INDEXED BY: without it SQLite picks the outlet index for the GROUP BY and
    // scans every order ever placed (seconds with a year of data).
    summary: db.prepare(`SELECT outlet_id, COUNT(*) AS orders, SUM(total) AS revenue FROM orders INDEXED BY orders_created
      WHERE status NOT IN ('cancelled', 'awaiting_payment', 'unpaid') AND created_at >= ? GROUP BY outlet_id`),

    openHandoff: db.prepare(`INSERT INTO wa_handoffs (phone, name, outlet_id, status, created_at, updated_at)
      VALUES (?, ?, ?, 'open', ?, ?)`),
    handoff: db.prepare('SELECT * FROM wa_handoffs WHERE id = ?'),
    openHandoffForPhone: db.prepare("SELECT * FROM wa_handoffs WHERE phone = ? AND status = 'open' ORDER BY id DESC LIMIT 1"),
    addHandoffMsg: db.prepare('INSERT INTO wa_handoff_messages (handoff_id, direction, body, at) VALUES (?, ?, ?, ?)'),
    touchHandoff: db.prepare('UPDATE wa_handoffs SET updated_at = ? WHERE id = ?'),
    handoffMsgs: db.prepare('SELECT direction, body, at FROM wa_handoff_messages WHERE handoff_id = ? ORDER BY id'),
    closeHandoff: db.prepare("UPDATE wa_handoffs SET status = 'closed', updated_at = ? WHERE id = ? AND status = 'open'"),

    allItems: db.prepare('SELECT * FROM menu_items ORDER BY sort, id'),
    rate: db.prepare(`INSERT INTO ratings (order_id, item_id, name, stars, outlet_id, phone, at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(order_id, item_id) DO UPDATE SET stars = excluded.stars, at = excluded.at`),
    ratingsFor: db.prepare('SELECT * FROM ratings WHERE order_id = ?'),
    ratingsBetween: db.prepare(`SELECT r.* FROM ratings r JOIN orders o ON o.id = r.order_id WHERE o.created_at >= ? AND o.created_at < ?`),
    comment: db.prepare(`INSERT INTO review_comments (order_id, comment, at) VALUES (?, ?, ?)
      ON CONFLICT(order_id) DO UPDATE SET comment = excluded.comment, at = excluded.at`),
    commentsBetween: db.prepare(`SELECT c.* FROM review_comments c JOIN orders o ON o.id = c.order_id WHERE o.created_at >= ? AND o.created_at < ?`),
    addJob: db.prepare('INSERT INTO scheduled_jobs (run_at, kind, payload) VALUES (?, ?, ?)'),
    dueJobs: db.prepare('SELECT * FROM scheduled_jobs WHERE done_at IS NULL AND run_at <= ? ORDER BY run_at LIMIT 50'),
    jobDone: db.prepare('UPDATE scheduled_jobs SET done_at = ? WHERE id = ? AND done_at IS NULL'),
    addEvent: db.prepare('INSERT INTO order_events (order_id, status, at) VALUES (?, ?, ?)'),
    eventsBetween: db.prepare(`SELECT e.order_id, e.status, e.at FROM order_events e JOIN orders o ON o.id = e.order_id
      WHERE o.created_at >= ? AND o.created_at < ? ORDER BY e.id`),
    customer: db.prepare('SELECT * FROM customers WHERE phone = ?'),
    customers: db.prepare('SELECT * FROM customers'),
    addPoints: db.prepare('INSERT OR IGNORE INTO loyalty_ledger (phone, order_id, points, kind, note, at) VALUES (?, ?, ?, ?, ?, ?)'),
    ledger: db.prepare('SELECT * FROM loyalty_ledger WHERE phone = ? ORDER BY id DESC'),
    balances: db.prepare('SELECT phone, SUM(points) AS balance FROM loyalty_ledger GROUP BY phone'),
    earnedFor: db.prepare("SELECT points FROM loyalty_ledger WHERE order_id = ? AND kind = 'earn'"),
    ordersForPhone: db.prepare('SELECT * FROM orders WHERE phone = ? ORDER BY id DESC'),
    ordersBetween: db.prepare('SELECT * FROM orders WHERE created_at >= ? AND created_at < ? ORDER BY created_at'),
    // Each customer's first (non-cancelled) order, for customers who ordered in a range.
    firstOrders: db.prepare(`SELECT p.phone, (SELECT o.created_at FROM orders o WHERE o.phone = p.phone AND o.status NOT IN ('cancelled', 'awaiting_payment', 'unpaid')
      ORDER BY o.created_at LIMIT 1) AS first FROM (SELECT DISTINCT phone FROM orders WHERE created_at >= ? AND created_at < ?) p`),
    customerStats: db.prepare(`SELECT phone, COUNT(*) AS orders, SUM(total) AS spent, MIN(created_at) AS first, MAX(created_at) AS last
      FROM orders WHERE status NOT IN ('cancelled', 'awaiting_payment', 'unpaid') GROUP BY phone`),
    customerStatsFor: db.prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS spent, MIN(created_at) AS first, MAX(created_at) AS last
      FROM orders WHERE phone = ? AND status NOT IN ('cancelled', 'awaiting_payment', 'unpaid')`),
    favOutletFor: db.prepare(`SELECT outlet_id FROM orders WHERE phone = ? AND status NOT IN ('cancelled', 'awaiting_payment', 'unpaid') GROUP BY outlet_id ORDER BY COUNT(*) DESC LIMIT 1`),
    repeatSpends: db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM orders WHERE status NOT IN ('cancelled', 'awaiting_payment', 'unpaid') GROUP BY phone HAVING COUNT(*) >= 2)`),
    vipCut: db.prepare(`SELECT SUM(total) AS spent FROM orders WHERE status NOT IN ('cancelled', 'awaiting_payment', 'unpaid') GROUP BY phone HAVING COUNT(*) >= 2
      ORDER BY spent DESC LIMIT 1 OFFSET ?`),
    balanceFor: db.prepare('SELECT COALESCE(SUM(points), 0) AS b FROM loyalty_ledger WHERE phone = ?'),
    customerOutlets: db.prepare(`SELECT phone, outlet_id, COUNT(*) AS n FROM orders WHERE status NOT IN ('cancelled', 'awaiting_payment', 'unpaid') GROUP BY phone, outlet_id`),
    linesBetween: db.prepare(`SELECT oi.order_id, oi.item_id, oi.name, oi.price, oi.qty, oi.note FROM order_items oi
      JOIN orders o ON o.id = oi.order_id WHERE o.created_at >= ? AND o.created_at < ?`),
    insertItem: db.prepare('INSERT INTO menu_items (category, name, description, price, veg, sort, active) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    addPriceHistory: db.prepare('INSERT INTO price_history (batch, item_id, old_price, new_price, note, at) VALUES (?, ?, ?, ?, ?, ?)'),
    lastBatch: db.prepare('SELECT * FROM price_history WHERE batch = (SELECT batch FROM price_history ORDER BY id DESC LIMIT 1)'),
    deleteBatch: db.prepare('DELETE FROM price_history WHERE batch = ?'),
    getSession: db.prepare('SELECT data, updated_at FROM wa_sessions WHERE phone = ?'),
    putSession: db.prepare(`INSERT INTO wa_sessions (phone, data, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`),
  };

  function transaction(fn) {
    db.exec('BEGIN');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  return {
    // Outlets & menu
    outlets: () => q.outlets.all(),
    outlet: (id) => q.outlet.get(id) || null,
    setAccepting: (id, accepting) => q.setAccepting.run(accepting ? 1 : 0, id),
    allOutlets: () => q.allOutlets.all(),
    insertOutlet: (o) => Number(q.insertOutlet.run(o).lastInsertRowid),
    updateOutlet(id, fields) {
      const cols = Object.keys(fields);
      if (!cols.length) return;
      db.prepare(`UPDATE outlets SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`).run({ ...fields, id });
    },
    menuItems: () => q.items.all(),
    unavailableItemIds: (outletId) => q.unavailable.all(outletId).map((r) => r.item_id),
    setAvailability: (outletId, itemId, available) => (available ? q.markIn : q.markOut).run(outletId, itemId),
    stockFor: (outletId) => q.stock.all(outletId),
    allStock: () => q.allStock.all(),
    allUnavailable: () => q.allUnavailable.all(),
    setStock: (outletId, itemId, remaining, ts) => (remaining == null ? q.clearStock.run(outletId, itemId) : q.setStock.run(outletId, itemId, remaining, ts)),
    adjustStock: (outletId, itemId, delta, ts) => q.adjustStock.run(delta, ts, outletId, itemId),
    outletPinHash: (outletId) => q.pinHash.get(outletId) || null,
    outletLogins: () => q.logins.all(),
    setOutletPin: (outletId, hash, ts) => q.setPin.run(outletId, hash, ts),
    addStaffSession: (tokenHash, outletId, createdAt, expiresAt) => q.addSession.run(tokenHash, outletId, createdAt, expiresAt),
    staffSession: (tokenHash, now) => q.session.get(tokenHash, now) || null,
    dropStaffSession: (tokenHash) => q.dropSession.run(tokenHash),
    dropStaffSessions: (outletId) => q.dropSessions.run(outletId),
    staffSessionCounts: (now) => q.sessionCounts.all(now),
    localities: () => q.localities.all(),

    // Orders
    orderCodeExists: (code) => !!q.byCode.get(code),
    // Gateway payment links for an order (oldest first).
    paymentLinks: (orderId) => q.paymentLinks.all(orderId),
    paymentLinkById: (id) => q.paymentLinkById.get(id) || null,
    insertPaymentLink: (l) => q.insertPaymentLink.run(l.id, l.order_id, l.provider, l.kind || 'link', l.url, l.amount, l.expires_at, l.status, l.created_at, l.created_at),
    /** Cancelled orders whose gateway payment hasn't been refunded yet (a refund failed). */
    refundsDue: () => q.refundsDue.all().map((r) => r.code),
    /** Payment requests not yet paid, failed or refunded, made since `since`. */
    openPaymentLinks: (since) => q.openPaymentLinks.all(since),
    updatePaymentLink: (id, { status, payment_id = null, refund_id = null }, ts) => q.updatePaymentLink.run(status, payment_id, refund_id, ts, id),
    // Connection settings (Head office → Connections).
    allSettings: () => q.allSettings.all(),
    setSetting: (key, value, secret, ts, by) => q.setSetting.run(key, value, secret ? 1 : 0, ts, by || null),
    deleteSetting: (key) => q.deleteSetting.run(key),
    addSettingsLog: (at, by, integration, change) => q.addSettingsLog.run(at, by || null, integration, change),
    settingsLog: (limit = 30) => q.settingsLog.all(limit),
    /** Record a gateway webhook event id; false if it was handled before. */
    gatewayEventSeen: (eventId, ts) => q.gatewayEventSeen.run(eventId, ts).changes === 0,
    // UPI orders nobody has paid (or said they paid) since before `cutoff`.
    unpaidBefore: (cutoff) => q.unpaidBefore.all(cutoff),
    insertOrder: (o, lines) => transaction(() => {
      const id = q.insertOrder.run(o.code, o.outlet_id, o.channel, o.fulfilment, o.customer_name, o.phone, o.address,
        o.lat, o.lng, o.distance_km, o.notes, o.subtotal, o.packing, o.gst, o.delivery_fee, o.total, o.payment_method,
        o.payment_status, o.status, o.created_at, o.updated_at).lastInsertRowid;
      for (const l of lines) q.insertLine.run(id, l.item_id, l.name, l.price, l.qty, l.note);
      return id;
    }),
    orderByCode: (code) => q.byCode.get(code) || null,
    orderLines: (orderId) => q.lines.all(orderId),
    latestOrderForPhone: (phone) => q.latestForPhone.get(phone) || null,
    listOrders({ outletId, statuses, limit }) {
      const where = [];
      const args = [];
      if (outletId) { where.push('outlet_id = ?'); args.push(outletId); }
      if (statuses && statuses.length) {
        where.push(`status IN (${statuses.map(() => '?').join(',')})`);
        args.push(...statuses);
      }
      const sql = `SELECT * FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
      return db.prepare(sql).all(...args, limit);
    },
    setOrderStatus: (id, from, to, ts) => q.setStatus.run(to, ts, id, from).changes > 0,
    setPaymentStatus: (id, from, to, ts) => q.setPayment.run(to, ts, id, from).changes > 0,
    summarySince: (iso) => q.summary.all(iso),
    orderById: (id) => q.byId.get(id) || null,

    // Delivery partner bookings
    getDelivery: (orderId) => q.getDelivery.get(orderId) || null,
    deliveryByRef: (ref) => q.deliveryByRef.get(ref) || null,
    upsertDelivery(orderId, fields) {
      const cur = q.getDelivery.get(orderId);
      const row = { provider: 'none', ref: null, status: 'FAILED', ...cur, ...fields, order_id: orderId };
      q.upsertDelivery.run(orderId, ...DELIVERY_COLS.map((k) => row[k] ?? null));
    },
    /** Per partner since a time: bookings, failures, average minutes to assign a rider. */
    deliveryStats: (sinceIso) => q.deliveryStats.all(sinceIso),
    /** Bookings still without a rider, booked before the cutoff. */
    staleDeliveries: (cutoffIso) => q.staleDeliveries.all(cutoffIso),

    // WhatsApp handoffs to staff
    openHandoff: ({ phone, name, outletId, ts }) => Number(q.openHandoff.run(phone, name || null, outletId || null, ts, ts).lastInsertRowid),
    handoff: (id) => q.handoff.get(id) || null,
    openHandoffForPhone: (phone) => q.openHandoffForPhone.get(phone) || null,
    addHandoffMessage: (id, direction, body, ts) => { q.addHandoffMsg.run(id, direction, body, ts); q.touchHandoff.run(ts, id); },
    handoffMessages: (id) => q.handoffMsgs.all(id),
    closeHandoff: (id, ts) => q.closeHandoff.run(ts, id).changes > 0,
    listHandoffs({ outletId, status }) {
      const where = ['status = ?'];
      const args = [status];
      if (outletId) { where.push('(outlet_id = ? OR outlet_id IS NULL)'); args.push(outletId); }
      return db.prepare(`SELECT * FROM wa_handoffs WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT 100`).all(...args);
    },

    // Menu management (includes inactive items)
    allMenuItems: () => q.allItems.all(),
    updateMenuItem(id, fields) {
      const allowed = ['category', 'name', 'description', 'price', 'veg', 'active', 'sort'];
      const keys = Object.keys(fields).filter((k) => allowed.includes(k));
      if (keys.length) db.prepare(`UPDATE menu_items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
    },
    insertMenuItem: (i) => Number(q.insertItem.run(i.category, i.name, i.description || '', i.price, i.veg ? 1 : 0, i.sort ?? 9999, i.active === 0 ? 0 : 1).lastInsertRowid),
    setPrices: (changes, batch, note, ts) => transaction(() => {
      for (const c of changes) {
        db.prepare('UPDATE menu_items SET price = ? WHERE id = ?').run(c.newPrice, c.id);
        if (batch) q.addPriceHistory.run(batch, c.id, c.oldPrice, c.newPrice, note || null, ts);
      }
    }),
    lastPriceBatch: () => q.lastBatch.all(),
    dropPriceBatch: (batch) => q.deleteBatch.run(batch),

    // CRM & loyalty
    customer: (phone) => q.customer.get(phone) || null,
    customers: () => q.customers.all(),
    upsertCustomer(c) {
      const cur = q.customer.get(c.phone);
      const row = { tags: '', notes: '', marketing_opt_in: 0, ...cur, ...Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)) };
      const cols = ['phone', 'name', 'first_seen_at', 'last_seen_at', 'first_channel', 'last_address', 'last_lat', 'last_lng', 'last_outlet_id', 'marketing_opt_in', 'tags', 'notes'];
      db.prepare(`INSERT INTO customers (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
        ON CONFLICT(phone) DO UPDATE SET ${cols.slice(1).map((k) => `${k} = excluded.${k}`).join(', ')}`)
        .run(...cols.map((k) => row[k] ?? null));
    },
    addPoints: (e) => q.addPoints.run(e.phone, e.orderId ?? null, e.points, e.kind, e.note ?? null, e.at).changes > 0,
    pointsLedger: (phone) => q.ledger.all(phone),
    pointsBalances: () => new Map(q.balances.all().map((r) => [r.phone, r.balance])),
    pointsEarnedFor: (orderId) => q.earnedFor.get(orderId)?.points ?? null,
    ordersForPhone: (phone) => q.ordersForPhone.all(phone),

    // Reviews
    addRating: (r) => q.rate.run(r.orderId, r.itemId, r.name, r.stars, r.outletId, r.phone, r.at),
    ratingsForOrder: (orderId) => q.ratingsFor.all(orderId),
    ratingsBetween: (fromIso, toIso) => q.ratingsBetween.all(fromIso, toIso),
    addReviewComment: (orderId, comment, at) => q.comment.run(orderId, comment, at),
    commentsBetween: (fromIso, toIso) => q.commentsBetween.all(fromIso, toIso),

    // Scheduled jobs
    addJob: (runAt, kind, payload) => Number(q.addJob.run(runAt, kind, JSON.stringify(payload)).lastInsertRowid),
    dueJobs: (nowIso) => q.dueJobs.all(nowIso).map((j) => ({ ...j, payload: JSON.parse(j.payload) })),
    markJobDone: (id, at) => q.jobDone.run(at, id).changes > 0,

    // Analytics
    addOrderEvent: (orderId, status, at) => q.addEvent.run(orderId, status, at),
    orderEventsBetween: (fromIso, toIso) => q.eventsBetween.all(fromIso, toIso),
    ordersBetween: (fromIso, toIso) => q.ordersBetween.all(fromIso, toIso),
    /** One customer's totals (cancelled orders excluded), or null when they have none. */
    customerStatsFor(phone) {
      const r = q.customerStatsFor.get(phone);
      if (!r || !r.orders) return null;
      return { orders: r.orders, spent: r.spent, first: r.first, last: r.last, outletId: q.favOutletFor.get(phone)?.outlet_id ?? null };
    },
    /** Spend that makes a customer VIP: the top 10% of customers with 2+ orders. */
    vipCutoff() {
      const n = q.repeatSpends.get().n;
      return n ? q.vipCut.get(Math.max(0, Math.ceil(n * 0.1) - 1))?.spent ?? Infinity : Infinity;
    },
    pointsBalance: (phone) => q.balanceFor.get(phone).b,
    firstOrders: (fromIso, toIso) => new Map(q.firstOrders.all(fromIso, toIso).map((r) => [r.phone, r.first])),
    /** Per customer: orders, spent, first, last, favourite outlet (cancelled orders excluded). */
    customerStats() {
      const stats = new Map(q.customerStats.all().map((r) => [r.phone, { orders: r.orders, spent: r.spent, first: r.first, last: r.last, outletId: null, top: 0 }]));
      for (const r of q.customerOutlets.all()) {
        const s = stats.get(r.phone);
        if (s && r.n > s.top) { s.top = r.n; s.outletId = r.outlet_id; }
      }
      return stats;
    },
    linesBetween: (fromIso, toIso) => q.linesBetween.all(fromIso, toIso),

    // WhatsApp conversation state
    getSession(phone) {
      const r = q.getSession.get(phone);
      return r ? { data: JSON.parse(r.data), updatedAt: r.updated_at } : null;
    },
    putSession: (phone, data, ts) => q.putSession.run(phone, JSON.stringify(data), ts),
  };
}

module.exports = { createSqliteStore };
