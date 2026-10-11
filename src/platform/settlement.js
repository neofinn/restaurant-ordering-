'use strict';

// Platform money: what each delivered order means for the restaurant, and the
// weekly settlement that pays it out.
//
// For every delivered order (food = items + packing):
//   commission      = food × the restaurant's commission %
//   commission GST  = 18% of the commission (the platform's invoice to the restaurant)
//   TDS             = food × TDS % (section 194-O, deducted by the platform)
//   PG fee          = order total × PG fee % on online orders (0 = platform absorbs it)
//   food GST        = kept by the platform when it pays GST on restaurant food
//                     (section 9(5)); otherwise passed on to the restaurant
//   delivery fee    = the platform's when its riders deliver; the restaurant's
//                     when it delivers with its own rider
//   restaurant share = food + passed-on GST + own-rider delivery fee
//                      − commission − commission GST − PG fee − TDS
// Paid online (the platform has the money): payout = share.
// Cash (the restaurant has the money): payout = share − total, usually negative:
// the restaurant owes the platform, deducted from its next payout.
//
// Razorpay Route: when a delivered order was paid through Razorpay and the
// restaurant has a linked account, the share is transferred to it right away
// but ON HOLD, so the money sits with Razorpay under the restaurant's name,
// not in the platform's account. The weekly settlement (Monday to Sunday, IST)
// adds everything up, takes back what the restaurant owes (partial reversals
// of held transfers) and releases the rest to its bank. Anything Route can't
// cover (no linked account, PhonePe or UPI payments, bonuses) is paid by bank
// transfer: the settlement shows it and a bank bulk-upload file lists it.

const DAY = 86400000;
const IST = 330 * 60000;

const pct = (amount, p) => Math.round((amount * (Number(p) || 0)) / 100);
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Monday (YYYY-MM-DD, IST) of the week a moment falls in. */
function weekOf(date = new Date()) {
  const ist = new Date(new Date(date).getTime() + IST);
  const back = (ist.getUTCDay() + 6) % 7; // days since Monday
  return ymd(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - back));
}
/** Start (inclusive) and end (exclusive) of an IST week as UTC ISO strings. */
function weekRange(monday) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(monday)) || weekOf(new Date(Date.parse(`${monday}T00:00:00Z`) - IST + 1)) !== monday) {
    throw new Error(`Not a Monday: ${monday}`);
  }
  const start = Date.parse(`${monday}T00:00:00Z`) - IST;
  return { from: new Date(start).toISOString(), to: new Date(start + 7 * DAY).toISOString(), weekStart: monday, weekEnd: ymd(start + IST + 6 * DAY) };
}

/**
 * The money of one delivered order. order: as orders.getOrder returns it, plus
 * paidVia ('gateway' | 'platform-upi' | 'restaurant-upi' | 'cash').
 */
function orderShare(order, { commissionPct, commissionGstPct = 18, tdsPct = 0, pgFeePct = 0, platformPaysFoodGst = true }) {
  const online = order.paidVia === 'gateway' || order.paidVia === 'platform-upi';
  const food = order.subtotal + order.packing;
  const ownRider = order.fulfilment === 'delivery' && !(order.delivery && order.delivery.status !== 'OWN' && order.delivery.provider);
  const commission = pct(food, commissionPct);
  const commissionGst = pct(commission, commissionGstPct);
  const tds = pct(food, tdsPct);
  const pgFee = online ? pct(order.total, pgFeePct) : 0;
  const gstKept = platformPaysFoodGst ? order.gst : 0;
  const share = food + (order.gst - gstKept) + (ownRider ? order.delivery_fee : 0) - commission - commissionGst - pgFee - tds;
  return {
    payment: order.paidVia === 'gateway' || order.paidVia === 'platform-upi' || order.paidVia === 'restaurant-upi' ? 'online' : 'cash',
    collected_by: online ? 'platform' : 'restaurant',
    subtotal: order.subtotal, packing: order.packing, gst: order.gst, delivery_fee: order.delivery_fee, total: order.total,
    commission, commission_gst: commissionGst, pg_fee: pgFee, tds, gst_kept: gstKept,
    payout: online ? share : share - order.total,
    terms: { commissionPct, commissionGstPct, tdsPct, pgFeePct, platformPaysFoodGst, ownRider },
  };
}

const LEDGER_COLS = ['restaurant_id', 'kind', 'order_code', 'outlet', 'at', 'payment', 'collected_by', 'subtotal', 'packing', 'gst', 'delivery_fee', 'total',
  'commission', 'commission_gst', 'pg_fee', 'tds', 'gst_kept', 'payout', 'terms', 'payment_id', 'transfer_status', 'note', 'created_by', 'created_at'];

function createSettlements({ db, terms, route = () => null, log = console }) {
  const q = {
    insert: db.prepare(`INSERT OR IGNORE INTO ledger (${LEDGER_COLS.join(', ')}) VALUES (${LEDGER_COLS.map((c) => `@${c}`).join(', ')})`),
    row: db.prepare('SELECT * FROM ledger WHERE id = ?'),
    byOrder: db.prepare("SELECT * FROM ledger WHERE restaurant_id = ? AND order_code = ? AND kind = 'order'"),
    setTransfer: db.prepare('UPDATE ledger SET transfer_id = ?, transfer_status = ?, transfer_amount = ?, transfer_error = ? WHERE id = ?'),
    open: db.prepare('SELECT * FROM ledger WHERE restaurant_id = ? AND settlement_id IS NULL AND at < ? ORDER BY at, id'),
    settle: db.prepare('UPDATE ledger SET settlement_id = ? WHERE id = ?'),
    rowsOf: db.prepare('SELECT * FROM ledger WHERE settlement_id = ? ORDER BY at, id'),
    restaurants: db.prepare('SELECT * FROM restaurants ORDER BY id'),
    restaurant: db.prepare('SELECT * FROM restaurants WHERE id = ?'),
    insertSettlement: db.prepare(`INSERT INTO settlements (restaurant_id, week_start, week_end, orders, sales, food, commission, commission_gst, pg_fee, tds,
      cash_collected, adjustments, net, via_route, manual, status, created_at)
      VALUES (@restaurant_id, @week_start, @week_end, @orders, @sales, @food, @commission, @commission_gst, @pg_fee, @tds,
      @cash_collected, @adjustments, @net, @via_route, @manual, @status, @created_at)`),
    settlement: db.prepare('SELECT * FROM settlements WHERE id = ?'),
    settlementFor: db.prepare('SELECT id FROM settlements WHERE restaurant_id = ? AND week_start = ?'),
    week: db.prepare('SELECT s.*, r.name, r.slug FROM settlements s JOIN restaurants r ON r.id = s.restaurant_id WHERE week_start = ? ORDER BY r.name'),
    weeks: db.prepare('SELECT week_start, week_end, COUNT(*) AS restaurants, SUM(net) AS net FROM settlements GROUP BY week_start ORDER BY week_start DESC LIMIT 26'),
  };
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  const MONEY = new Set(['subtotal', 'packing', 'gst', 'delivery_fee', 'total', 'commission', 'commission_gst', 'pg_fee', 'tds', 'gst_kept']);
  const insertRow = (row) => q.insert.run(Object.fromEntries(LEDGER_COLS.map((c) => [c, row[c] ?? (MONEY.has(c) ? 0 : null)])));

  /**
   * A delivered order. Writes its ledger row once (repeats are ignored), then
   * starts the Route transfer when the platform holds the money. Returns the row.
   */
  async function recordOrder(restaurant, order, now = new Date()) {
    const existing = q.byOrder.get(restaurant.id, order.code);
    if (existing) return existing;
    const s = orderShare(order, { ...terms(), commissionPct: restaurant.commission_pct });
    const transferable = s.collected_by === 'platform' && order.paymentId && order.provider === 'razorpay';
    insertRow({
      ...s, restaurant_id: restaurant.id, kind: 'order', order_code: order.code, outlet: order.outlet?.name || null,
      at: now.toISOString(), terms: JSON.stringify(s.terms), payment_id: order.paymentId || null,
      transfer_status: transferable ? 'pending' : 'none', created_by: 'system', created_at: now.toISOString(),
    });
    const row = q.byOrder.get(restaurant.id, order.code);
    if (transferable) await transfer(restaurant, row);
    return q.row.get(row.id);
  }

  // Route transfer of an order's payout, on hold until the weekly release.
  async function transfer(restaurant, row) {
    const rp = route();
    if (!rp || !restaurant.route_account || row.payout <= 0) {
      q.setTransfer.run(null, 'none', null, !restaurant.route_account ? 'No Route linked account' : !rp ? 'Razorpay not connected' : null, row.id);
      return;
    }
    try {
      const t = await rp.transfer(row.payment_id, { account: restaurant.route_account, amount: row.payout, onHold: true, notes: { order: row.order_code, restaurant: restaurant.slug } });
      q.setTransfer.run(t.id, 'held', row.payout, null, row.id);
    } catch (e) {
      log.error(`[settlement] Route transfer for ${restaurant.slug} ${row.order_code} failed: ${e.message}`);
      q.setTransfer.run(null, 'failed', null, e.message.slice(0, 300), row.id);
    }
  }

  /** An adjustment: amount in paise, positive = the restaurant gets more. */
  function addAdjustment(restaurantId, { amount, note, by = 'platform', at = new Date() }) {
    const r = q.restaurant.get(Number(restaurantId));
    if (!r) throw new Error('Unknown restaurant');
    const paise = Math.round(Number(amount));
    if (!Number.isFinite(paise) || paise === 0) throw new Error('Amount must be a non-zero number of paise.');
    if (!String(note || '').trim()) throw new Error('Say what the adjustment is for.');
    const ts = new Date(at).toISOString();
    const { lastInsertRowid } = insertRow({ restaurant_id: r.id, kind: 'adjustment', at: ts, payout: paise, note: String(note).trim().slice(0, 300), transfer_status: 'none', created_by: by, created_at: new Date().toISOString() });
    return q.row.get(lastInsertRowid);
  }

  const sum = (rows, f) => rows.reduce((a, r) => a + (typeof f === 'function' ? f(r) : r[f] || 0), 0);

  /**
   * Close a week (Monday YYYY-MM-DD) for every restaurant: one statement each
   * from all its unsettled rows up to the end of that week. A negative balance
   * is carried into the next week. Closing twice does nothing more.
   */
  function closeWeek(monday, now = new Date()) {
    const { to, weekStart, weekEnd } = weekRange(monday);
    if (to > now.toISOString()) throw new Error(`The week of ${weekStart} isn't over yet.`);
    const made = [];
    for (const r of q.restaurants.all()) {
      if (q.settlementFor.get(r.id, weekStart)) continue;
      const rows = q.open.all(r.id, to);
      if (!rows.length) continue;
      made.push(tx(() => {
        const orders = rows.filter((x) => x.kind === 'order');
        const net = sum(rows, 'payout');
        const held = sum(rows.filter((x) => x.transfer_status === 'held'), 'transfer_amount');
        const viaRoute = net > 0 ? Math.min(held, net) : 0;
        const st = {
          restaurant_id: r.id, week_start: weekStart, week_end: weekEnd, orders: orders.length,
          sales: sum(orders, 'total'), food: sum(orders, (x) => x.subtotal + x.packing), commission: sum(orders, 'commission'),
          commission_gst: sum(orders, 'commission_gst'), pg_fee: sum(orders, 'pg_fee'), tds: sum(orders, 'tds'),
          cash_collected: sum(orders.filter((x) => x.collected_by === 'restaurant'), 'total'),
          adjustments: sum(rows.filter((x) => x.kind === 'adjustment'), 'payout'), net,
          via_route: viaRoute, manual: net > 0 ? net - viaRoute : 0,
          // A negative week with held transfers is 'ready' too: releasing it takes them back.
          status: net > 0 || held > 0 ? 'ready' : net < 0 ? 'carried' : 'nothing', created_at: now.toISOString(),
        };
        const id = Number(q.insertSettlement.run(st).lastInsertRowid);
        for (const x of rows) q.settle.run(id, x.id);
        // What's still owed starts next week's statement.
        if (net < 0) {
          insertRow({ restaurant_id: r.id, kind: 'adjustment', at: to, payout: net, note: `Balance carried from week of ${weekStart}`, transfer_status: 'none', created_by: 'system', created_at: now.toISOString() });
        }
        return q.settlement.get(id);
      }));
    }
    return made;
  }

  /**
   * Pay a ready statement through Route: take back what the restaurant owes
   * from its held transfers (largest first), release the rest. The bank part
   * (manual) is then paid by the platform and marked with markPaid.
   */
  async function release(id, by = 'platform', now = new Date()) {
    const st = q.settlement.get(Number(id));
    if (!st) throw new Error('Unknown settlement');
    if (st.status !== 'ready') throw new Error(`This statement is ${st.status}.`);
    const held = q.rowsOf.all(st.id).filter((x) => x.transfer_status === 'held').sort((a, b) => b.transfer_amount - a.transfer_amount);
    let excess = sum(held, 'transfer_amount') - st.via_route;
    const rp = held.length ? route() : null;
    if (held.length && !rp) throw new Error('Connect Razorpay (Route) first.');
    const errors = [];
    for (const x of held) {
      try {
        let keep = x.transfer_amount;
        if (excess > 0) {
          const back = Math.min(excess, keep);
          await rp.reverse(x.transfer_id, back);
          excess -= back;
          keep -= back;
          q.setTransfer.run(x.transfer_id, keep ? 'held' : 'reversed', keep, null, x.id);
        }
        if (keep > 0) {
          await rp.release(x.transfer_id);
          q.setTransfer.run(x.transfer_id, 'released', keep, null, x.id);
        }
      } catch (e) {
        errors.push(`${x.order_code}: ${e.message}`);
        q.setTransfer.run(x.transfer_id, 'held', q.row.get(x.id).transfer_amount, e.message.slice(0, 300), x.id);
      }
    }
    if (errors.length) {
      db.prepare('UPDATE settlements SET error = ? WHERE id = ?').run(errors.join('; ').slice(0, 1000), st.id);
      throw new Error(`Some transfers failed (run release again to retry): ${errors.join('; ')}`);
    }
    const status = st.net < 0 ? 'carried' : st.manual > 0 ? 'released' : 'paid';
    db.prepare('UPDATE settlements SET status = ?, released_at = ?, released_by = ?, error = NULL, paid_at = CASE WHEN ? = \'paid\' THEN ? ELSE paid_at END WHERE id = ?')
      .run(status, now.toISOString(), by, status, now.toISOString(), st.id);
    return q.settlement.get(st.id);
  }

  /** The bank-transfer part has been paid: UTR / reference from the bank. */
  function markPaid(id, reference, by = 'platform', now = new Date()) {
    const st = q.settlement.get(Number(id));
    if (!st) throw new Error('Unknown settlement');
    const ref = String(reference || '').trim();
    if (!ref) throw new Error('Enter the bank reference (UTR).');
    if (st.status === 'ready' && st.via_route > 0) throw new Error('Release the Route transfers first.');
    if (!['ready', 'released'].includes(st.status)) throw new Error(`This statement is ${st.status}.`);
    db.prepare("UPDATE settlements SET status = 'paid', reference = ?, paid_at = ?, paid_by = ? WHERE id = ?").run(ref.slice(0, 64), now.toISOString(), by, st.id);
    return q.settlement.get(st.id);
  }

  const csvCell = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
  const csv = (rows) => `${rows.map((r) => r.map(csvCell).join(',')).join('\n')}\n`;
  const rs = (p) => (p / 100).toFixed(2);

  /** A restaurant's statement: every order and adjustment of the week. */
  function statementCsv(id) {
    const st = q.settlement.get(Number(id));
    if (!st) return null;
    const r = q.restaurant.get(st.restaurant_id);
    const rows = q.rowsOf.all(st.id);
    return {
      filename: `${r.slug}-statement-${st.week_start}.csv`,
      text: csv([
        [`${r.name} · settlement ${st.week_start} to ${st.week_end}`],
        ['Date', 'Type', 'Order', 'Outlet', 'Payment', 'Items', 'Packing', 'GST', 'Delivery fee', 'Customer paid', 'Commission', 'GST on commission', 'PG fee', 'TDS 194-O', 'Food GST paid by platform', 'Payout', 'Note'],
        ...rows.map((x) => [x.at.slice(0, 10), x.kind, x.order_code || '', x.outlet || '', x.payment ? `${x.payment} (${x.collected_by})` : '', rs(x.subtotal), rs(x.packing), rs(x.gst), rs(x.delivery_fee),
          rs(x.total), rs(x.commission), rs(x.commission_gst), rs(x.pg_fee), rs(x.tds), rs(x.gst_kept), rs(x.payout), x.note || '']),
        [],
        ['Orders', st.orders], ['Customers paid', rs(st.sales)], ['Food value', rs(st.food)], ['Commission', rs(st.commission)], ['GST on commission', rs(st.commission_gst)],
        ['PG fee', rs(st.pg_fee)], ['TDS 194-O', rs(st.tds)], ['Cash kept by restaurant', rs(st.cash_collected)], ['Adjustments', rs(st.adjustments)],
        ['Net payable', rs(st.net)], ['Paid via Razorpay Route', rs(st.via_route)], ['Paid by bank transfer', rs(st.manual)], ['Status', st.status], ['Bank reference', st.reference || ''],
      ]),
    };
  }

  /** Bank bulk-upload list for a week: the bank-transfer part of each statement. */
  function bankCsv(monday) {
    const due = q.week.all(monday).filter((s) => s.manual > 0 && s.status !== 'paid');
    const rows = due.map((s) => {
      const r = q.restaurant.get(s.restaurant_id);
      return [r.legal_name || r.name, r.bank_account || 'MISSING', r.bank_ifsc || 'MISSING', r.bank_name || '', rs(s.manual), `Settlement ${s.week_start} ${r.slug}`, r.email || ''];
    });
    return { filename: `payouts-${monday}.csv`, text: csv([['Beneficiary name', 'Account number', 'IFSC', 'Bank', 'Amount', 'Narration', 'Email'], ...rows]) };
  }

  return {
    recordOrder, addAdjustment, closeWeek, release, markPaid, statementCsv, bankCsv,
    retryTransfer: async (rowId) => {
      const row = q.row.get(Number(rowId));
      if (!row || !['failed', 'none'].includes(row.transfer_status) || !row.payment_id || row.settlement_id) return row;
      await transfer(q.restaurant.get(row.restaurant_id), row);
      return q.row.get(row.id);
    },
    settlement: (id) => q.settlement.get(Number(id)),
    rows: (id) => q.rowsOf.all(Number(id)),
    week: (monday) => q.week.all(monday),
    weeks: () => q.weeks.all(),
    /** Unsettled rows of a restaurant (or all): what next week's statement holds so far. */
    open: (restaurantId) => (restaurantId
      ? q.open.all(Number(restaurantId), '9999')
      : db.prepare('SELECT l.*, r.slug FROM ledger l JOIN restaurants r ON r.id = l.restaurant_id WHERE settlement_id IS NULL ORDER BY at DESC LIMIT 500').all()),
  };
}

module.exports = { createSettlements, orderShare, weekOf, weekRange };
