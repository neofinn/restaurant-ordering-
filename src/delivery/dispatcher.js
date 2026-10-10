'use strict';

// Books delivery riders across several partners (Shadowfax, Porter, Borzo, …)
// and keeps our orders in step with them.
//
// Flow: the outlet accepts a delivery order -> the selector (selector.js) asks
// every partner for a quote and ranks them by price, expected wait for a rider
// and recent reliability -> we book the best one, falling through the list if
// a booking is refused. Partner updates (webhooks, or the simulator) arrive as
// normalised updates: "DISPATCHED" moves our order to out for delivery,
// "DELIVERED" completes it.
//
// Fallbacks, so one partner's bad hour doesn't strand food:
// - no rider assigned within reassignMinutes -> cancel there, book the next partner;
// - the partner cancels -> book the next partner automatically;
// - nobody can take it -> staff see why on the dashboard and can retry or use
//   their own rider.
//
// A provider: { name, label, supportsCod, ready(outlet), quote(order, outlet),
// book(order, outlet), cancel(ref, reason), parseCallback(body) }. quote/ready
// are optional (a provider without them is always tried, at no known price).

const { EventEmitter } = require('node:events');
const { DELIVERY_LABELS } = require('../orders');
const { createSelector } = require('./selector');
const { parseShadowfaxCallback } = require('./shadowfax');

const FAILED = new Set(['CANCELLED', 'CANCELLED_BY_CUSTOMER', 'RETURNED_TO_SELLER', 'UNDELIVERED', 'FAILED']);
const WAITING = new Set(['BOOKING', 'ACCEPTED', 'UNASSIGNED']);
const RIDER_STATUSES = new Set(['ALLOTTED', 'ARRIVED', 'DISPATCHED', 'ARRIVED_CUSTOMER_DOORSTEP', 'DELIVERED']);

const label = (status) => DELIVERY_LABELS[status === 'ALLOTED' ? 'ALLOTTED' : status] || status;
// tried comes parsed from orders.getOrder(), or as JSON straight from the store.
const parseList = (v) => { if (Array.isArray(v)) return v; try { return JSON.parse(v || '[]'); } catch { return []; } };

// Walk our order forward to a target status through allowed steps.
const DELIVERY_PATH = ['placed', 'accepted', 'preparing', 'out_for_delivery', 'completed'];

function createDispatcher({
  orders, store, provider, providers, selector, bookOn = 'accepted', reassignMinutes = 8, log = console,
}) {
  const events = new EventEmitter();
  // Partners can be swapped while running (Head office → Connections).
  let list = providers || (provider ? [provider] : []);
  let byName = new Map(list.map((p) => [p.name, p]));
  const isEnabled = () => list.length > 0;
  const pick = selector || createSelector({ store });
  let sweeper = null;

  function save(order, fields, change) {
    store.upsertDelivery(order.id, { ...fields, updated_at: new Date().toISOString() });
    const fresh = orders.getOrder(order.code);
    events.emit('delivery', fresh, change);
    return fresh;
  }

  function advance(order, target) {
    let o = order;
    const goal = DELIVERY_PATH.indexOf(target);
    while (o && DELIVERY_PATH.indexOf(o.status) < goal && o.status !== 'cancelled') {
      const next = DELIVERY_PATH[DELIVERY_PATH.indexOf(o.status) + 1];
      // Only the final step notifies the customer.
      o = orders.updateStatus(o.code, next, new Date(), { by: 'delivery', quiet: next !== target });
    }
    return o;
  }

  const quoteSummary = (ranked, rejected) => JSON.stringify([
    ...ranked.map((r) => ({ name: r.provider.name, label: r.provider.label || r.provider.name, price: r.price, etaMin: r.etaMin, score: r.score })),
    ...rejected.map((r) => ({ name: r.name, label: r.label || r.name, reason: r.reason })),
  ]);

  // Try the ranked partners in order until one accepts the booking.
  async function bookRanked(order, outlet, ranked, rejected, tried) {
    const quotes = quoteSummary(ranked, rejected);
    const reasons = rejected.filter((r) => r.reason !== 'already tried for this order').map((r) => `${r.label || r.name}: ${r.reason}`);
    for (const r of ranked) {
      const p = r.provider;
      tried = [...new Set([...tried, p.name])];
      try {
        const res = await p.book(order, outlet);
        const now = new Date().toISOString();
        return save(order, {
          provider: p.name, ref: res.ref, status: res.status || 'ACCEPTED', track_url: res.trackUrl || null, error: null,
          rider_name: res.rider?.name || null, rider_phone: res.rider?.phone || null, rider_lat: null, rider_lng: null,
          price: res.price ?? r.price ?? null, booked_at: now, allotted_at: res.rider ? now : null,
          tried: JSON.stringify(tried), quotes,
        }, res.rider ? 'rider_assigned' : 'booked');
      } catch (e) {
        log.error(`[delivery] ${p.name} booking failed`, e.message);
        reasons.push(`${p.label || p.name}: ${e.message}`);
      }
    }
    return save(order, {
      provider: ranked[0]?.provider.name || list[0]?.name || 'none', ref: null, status: 'FAILED',
      error: reasons.length ? reasons.join('; ') : 'No delivery partner is available', tried: JSON.stringify(tried), quotes,
    }, 'failed');
  }

  /** Book a rider for a delivery order. Safe to call again after a failure (it tries every partner again). */
  async function book(code) {
    const order = orders.getOrder(code);
    // No rider for orders that are finished, or not yet paid / never paid.
    if (!order || order.fulfilment !== 'delivery' || ['completed', 'cancelled', 'awaiting_payment', 'unpaid'].includes(order.status)) return order;
    const current = order.delivery;
    if (current && !['FAILED', 'OWN'].includes(current.status) && !FAILED.has(current.status)) return order;
    if (!isEnabled()) return save(order, { provider: 'none', status: 'FAILED', error: 'No delivery partner is configured' }, 'failed');
    const outlet = store.outlet(order.outlet_id);
    save(order, { provider: 'selecting', ref: null, status: 'BOOKING', error: null, rider_name: null, rider_phone: null, rider_lat: null, rider_lng: null, track_url: null, tried: '[]' }, 'booking');
    const { ranked, rejected } = await pick.rank(order, outlet, list, []);
    return bookRanked(order, outlet, ranked, rejected, []);
  }

  /**
   * Move a booking to the next partner (no rider in time, or the partner
   * cancelled). Leaves it alone when no other partner can take it.
   */
  async function reassign(order, why) {
    const d = order.delivery;
    const tried = parseList(d.tried).concat(d.provider);
    const outlet = store.outlet(order.outlet_id);
    const { ranked, rejected } = await pick.rank(order, outlet, list, tried);
    if (!ranked.length) {
      if (WAITING.has(d.status)) save(order, { error: `${why}; no other partner can take it, still waiting` }, 'waiting');
      return orders.getOrder(order.code);
    }
    const p = byName.get(d.provider);
    if (d.ref && p && !FAILED.has(d.status)) p.cancel(d.ref, why).catch((e) => log.error('[delivery] cancel failed', e.message));
    log.error?.(`[delivery] ${order.code}: ${why}; moving from ${d.provider} to the next partner`);
    return bookRanked(orders.getOrder(order.code), outlet, ranked, rejected, tried);
  }

  /** Staff deliver it themselves. */
  function useOwnRider(code) {
    const order = orders.getOrder(code);
    if (!order) return null;
    const d = order.delivery;
    const p = d && byName.get(d.provider);
    if (d?.ref && p && !FAILED.has(d.status) && d.status !== 'DELIVERED') {
      p.cancel(d.ref, 'Outlet delivering with own rider').catch((e) => log.error('[delivery] cancel failed', e.message));
    }
    return save(order, { provider: 'own', status: 'OWN', error: null }, 'own');
  }

  /**
   * A normalised partner update: { ref, clientOrderId, status, rider: {name, phone, lat, lng}, trackUrl, error }.
   * Returns the updated order, or null if it isn't one of ours (or is from a
   * partner we already moved away from).
   */
  function handleUpdate(providerName, u) {
    const byRef = u.ref ? store.deliveryByRef(u.ref) : null;
    const order = byRef ? orders.getOrderById(byRef.order_id) : (u.clientOrderId ? orders.getOrder(u.clientOrderId) : null);
    const cur = order?.delivery;
    if (!order || !cur || cur.status === 'OWN') return null;
    if (providerName && cur.provider !== providerName) return null; // a late update from an earlier partner
    if (u.ref && cur.ref && u.ref !== cur.ref) return null;

    const status = u.status ? (u.status === 'ALLOTED' ? 'ALLOTTED' : u.status) : cur.status;
    const r = u.rider || {};
    const fields = {
      ref: u.ref || cur.ref,
      status,
      rider_name: r.name || cur.rider_name,
      rider_phone: r.phone || cur.rider_phone,
      rider_lat: r.lat != null ? r.lat : cur.rider_lat,
      rider_lng: r.lng != null ? r.lng : cur.rider_lng,
      track_url: u.trackUrl || cur.track_url,
      error: FAILED.has(status) ? (u.error || label(status)) : null,
      allotted_at: cur.allotted_at || (RIDER_STATUSES.has(status) ? new Date().toISOString() : null),
    };
    const statusChanged = fields.status !== cur.status;
    let updated = save(order, fields, statusChanged ? fields.status.toLowerCase() : 'location');
    if (!statusChanged) return updated;

    if (status === 'DISPATCHED') updated = advance(updated, 'out_for_delivery') || updated;
    if (status === 'DELIVERED') updated = advance(updated, 'completed') || updated;
    // The partner gave up before pickup: try the next one.
    if (FAILED.has(status) && !['completed', 'cancelled', 'out_for_delivery'].includes(updated.status)) {
      reassign(updated, `${byName.get(cur.provider)?.label || cur.provider} cancelled`).catch((e) => log.error('[delivery] reassign failed', e.message));
    }
    return updated;
  }

  /** Shadowfax callback body (kept for the existing webhook and tests). */
  const handleCallback = (payload) => handleUpdate('shadowfax', parseShadowfaxCallback(payload));

  /** Partner webhook body -> update. */
  function handleWebhook(providerName, body) {
    const p = byName.get(providerName);
    const parse = p?.parseCallback || (providerName === 'shadowfax' ? parseShadowfaxCallback : null);
    return parse ? handleUpdate(providerName, parse(body)) : null;
  }

  /** Bookings with no rider after reassignMinutes move to the next partner. */
  async function sweep(now = new Date()) {
    const cutoff = new Date(now.getTime() - reassignMinutes * 60000).toISOString();
    for (const d of store.staleDeliveries(cutoff)) {
      const order = orders.getOrderById(d.order_id);
      if (!order || ['completed', 'cancelled'].includes(order.status)) continue;
      // eslint-disable-next-line no-await-in-loop
      await reassign(order, `No rider from ${byName.get(d.provider)?.label || d.provider} in ${reassignMinutes} min`);
    }
  }

  // Book automatically when the outlet accepts (or starts preparing) a delivery order;
  // release the rider if the order is cancelled.
  orders.events.on('status', (o, meta = {}) => {
    if (o.fulfilment !== 'delivery' || meta.by === 'delivery') return;
    if (isEnabled() && o.status === bookOn && !o.delivery) book(o.code);
    const p = o.delivery && byName.get(o.delivery.provider);
    if (o.status === 'cancelled' && o.delivery?.ref && p && !FAILED.has(o.delivery.status)) {
      p.cancel(o.delivery.ref, 'Order cancelled by outlet').catch((e) => log.error('[delivery] cancel failed', e.message));
      save(o, { status: 'CANCELLED', error: 'Order cancelled by outlet' }, 'cancelled');
    }
  });

  return {
    events,
    get enabled() { return isEnabled(); },
    get providers() { return list; },
    /** Use a new set of partners from now on (bookings in progress keep working by name while kept). */
    setProviders(next) {
      // Keep old partners reachable by name so their late updates and cancels still work.
      const old = byName;
      list = next;
      byName = new Map([...old, ...next.map((p) => [p.name, p])]);
    },
    book, reassign, useOwnRider, handleUpdate, handleCallback, handleWebhook, sweep, label,
    startSweeper(intervalMs = 60000) {
      if (!sweeper) { sweeper = setInterval(() => { sweep().catch((e) => log.error('[delivery] sweep failed', e.message)); }, intervalMs); sweeper.unref?.(); }
    },
    stopSweeper() { clearInterval(sweeper); sweeper = null; },
  };
}

module.exports = { createDispatcher };
