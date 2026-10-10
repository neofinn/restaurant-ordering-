'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const config = require('./config');
const { assignOutlet, isOpen, etaMinutes } = require('./geo');
const { upiFor, upiLink, PAYMENT_LABELS } = require('./payments');
const { brand } = require('./brand');

// Delivery partner statuses as staff and customers see them (see delivery/dispatcher.js).
const DELIVERY_LABELS = {
  BOOKING: 'Booking a rider', ACCEPTED: 'Looking for a rider', UNASSIGNED: 'Looking for a rider',
  ALLOTTED: 'Rider assigned', ARRIVED: 'Rider at the outlet', DISPATCHED: 'Rider on the way',
  ARRIVED_CUSTOMER_DOORSTEP: 'Rider at the door', DELIVERED: 'Delivered', CANCELLED: 'Partner cancelled',
  CANCELLED_BY_CUSTOMER: 'Customer cancelled', RETURNED_TO_SELLER: 'Returned to outlet', UNDELIVERED: 'Not delivered',
  FAILED: 'Rider booking failed', OWN: 'Outlet rider',
};
const PROVIDER_LABELS = { shadowfax: 'Shadowfax', porter: 'Porter', borzo: 'Borzo', own: 'Outlet rider', selecting: 'Choosing a partner', none: 'No partner' };
const parseJson = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

class ValidationError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.code = code;
    this.status = 400;
  }
}

const STATUSES = ['awaiting_payment', 'placed', 'accepted', 'preparing', 'ready', 'out_for_delivery', 'completed', 'cancelled', 'unpaid'];

// An order paid online by UPI waits in awaiting_payment: the outlet doesn't
// cook it and the customer isn't told "order placed" until the money is in
// (WhatsApp confirms it, or staff see it in their UPI app). It then moves to
// placed. Not paid within config.payments.windowMinutes: unpaid (cancelled,
// stock put back). Neither state is a sale.
const NOT_SALES = ['cancelled', 'awaiting_payment', 'unpaid'];

// Allowed next statuses, per fulfilment type.
const TRANSITIONS = {
  delivery: {
    awaiting_payment: ['cancelled'],
    placed: ['accepted', 'cancelled'],
    accepted: ['preparing', 'cancelled'],
    preparing: ['out_for_delivery', 'cancelled'],
    out_for_delivery: ['completed'],
  },
  pickup: {
    awaiting_payment: ['cancelled'],
    placed: ['accepted', 'cancelled'],
    accepted: ['preparing', 'cancelled'],
    preparing: ['ready', 'cancelled'],
    ready: ['completed'],
  },
};

const STATUS_LABELS = {
  awaiting_payment: 'Waiting for payment',
  placed: 'Order placed',
  accepted: 'Accepted by outlet',
  preparing: 'Being prepared',
  ready: 'Ready for pickup',
  out_for_delivery: 'Out for delivery',
  completed: 'Completed',
  cancelled: 'Cancelled',
  unpaid: 'Not paid in time',
};

const MAX_QTY_PER_ITEM = 20;

// Online payments go through the gateway when Razorpay keys are set.
const gatewayOn = () => Boolean(config.paymentGateway?.());
/** Can this outlet take "Pay now" (gateway, or a UPI ID for the dynamic QR)? */
const canPayOnline = (outlet) => gatewayOn() || Boolean(upiFor(outlet));

/** Normalise an Indian mobile number to +91XXXXXXXXXX, or return null. */
function normalisePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  const local = digits.length === 12 && digits.startsWith('91') ? digits.slice(2)
    : digits.length === 11 && digits.startsWith('0') ? digits.slice(1)
      : digits;
  return /^[6-9]\d{9}$/.test(local) ? `+91${local}` : null;
}

/** Delivery charge for this road distance (our published rate card, whichever partner delivers). */
function deliveryCharge(distanceKm) {
  const d = config.delivery;
  return d.baseFee + Math.ceil(Math.max(0, (distanceKm || 0) - d.baseKm)) * d.perKmFee;
}

/** What the customer pays for delivery: the partner charge, unless the order qualifies for free delivery. */
function deliveryFee(subtotal, distanceKm) {
  const free = config.pricing.freeDeliveryAbove;
  return free > 0 && subtotal >= free ? 0 : deliveryCharge(distanceKm);
}

/**
 * Price cart lines ({id, qty, note?}) against a menu list. Lines for the same
 * item with different notes ("less spicy" vs none) stay separate.
 */
function priceCart(menuList, items, fulfilment, distanceKm) {
  if (!Array.isArray(items) || items.length === 0) throw new ValidationError('Your cart is empty.');
  const menu = new Map(menuList.map((i) => [i.id, i]));
  const merged = new Map();
  const perItem = new Map();
  for (const line of items) {
    const id = Number(line.id);
    const qty = Number(line.qty);
    const note = String(line.note || '').trim().slice(0, 120);
    if (!Number.isInteger(qty) || qty < 1) throw new ValidationError('Invalid quantity.');
    const key = `${id}|${note.toLowerCase()}`;
    const m = merged.get(key) || { id, qty: 0, note };
    m.qty += qty;
    merged.set(key, m);
    perItem.set(id, (perItem.get(id) || 0) + qty);
  }
  const lines = [];
  for (const { id, qty, note } of merged.values()) {
    const item = menu.get(id);
    if (!item) throw new ValidationError('An item in your cart is no longer on the menu.');
    if (!item.available) throw new ValidationError(`${item.name} is not available at this outlet right now.`, 'unavailable');
    if (perItem.get(id) > MAX_QTY_PER_ITEM) throw new ValidationError(`Maximum ${MAX_QTY_PER_ITEM} of ${item.name} per order.`);
    if (item.remaining != null && perItem.get(id) > item.remaining) {
      throw new ValidationError(`Only ${item.remaining} × ${item.name} left at this outlet right now.`, 'low_stock');
    }
    lines.push({ item_id: id, name: item.name, price: item.price, qty, note: note || null });
  }
  const p = config.pricing;
  const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const packing = p.packingPerOrder;
  const gst = Math.round(((subtotal + packing) * p.gstPercent) / 100);
  const delivery = fulfilment === 'delivery';
  const fee = delivery ? deliveryFee(subtotal, distanceKm) : 0;
  return {
    lines, subtotal, packing, gst, deliveryFee: fee, total: subtotal + packing + gst + fee,
    // Shown on the bill: "Delivery (6.2 km)", with the charge even when it's free.
    deliveryKm: delivery ? distanceKm : null,
    deliveryCharge: delivery ? deliveryCharge(distanceKm) : 0,
    deliveryPartner: delivery ? config.delivery.partner : null,
    minDeliveryOrder: p.minDeliveryOrder, freeDeliveryAbove: p.freeDeliveryAbove,
  };
}

function createOrderService(store) {
  const events = new EventEmitter();

  const listOutlets = () => store.outlets();
  const getOutlet = (id) => store.outlet(id);

  /**
   * Menu for an outlet, with its stock applied: items switched off by head
   * office, or whose stock count has run out, are unavailable. `remaining` is
   * the count left, or null when the item has no limit.
   */
  function menuFor(outletId) {
    const out = new Set(outletId ? store.unavailableItemIds(outletId) : []);
    const left = new Map(outletId ? store.stockFor(outletId).map((r) => [r.item_id, r.remaining]) : []);
    return store.menuItems().map((i) => ({
      id: i.id, category: i.category, name: i.name, description: i.description,
      price: i.price, veg: !!i.veg, available: !out.has(i.id) && (left.get(i.id) ?? 1) > 0,
      remaining: left.has(i.id) ? left.get(i.id) : null,
    }));
  }

  function categories(outletId) {
    const seen = new Map();
    for (const i of menuFor(outletId)) {
      if (!seen.has(i.category)) seen.set(i.category, []);
      seen.get(i.category).push(i);
    }
    return [...seen].map(([name, items]) => ({ name, items }));
  }

  /**
   * Resolve which outlet serves a request. For delivery the outlet is always
   * derived from the customer's coordinates; a client-supplied outlet id is
   * only honoured for pickup.
   */
  function resolveOutlet({ fulfilment, lat, lng, outletId }, now = new Date()) {
    if (fulfilment === 'pickup') {
      const outlet = outletId ? getOutlet(outletId) : null;
      if (outlet) {
        if (!isOpen(outlet, now)) throw new ValidationError(`${outlet.name} is closed right now.`, 'closed');
        return { outlet, distanceKm: null };
      }
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new ValidationError('Choose an outlet for pickup.');
    } else if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new ValidationError('Delivery location is required.');
    }
    const a = assignOutlet(listOutlets(), { lat, lng }, { fulfilment, now });
    if (!a.outlet) {
      const msg = a.reason === 'closed'
        ? 'Outlets near you are closed right now.'
        : 'Sorry, we do not deliver to this location yet. You can still order for pickup.';
      throw new ValidationError(msg, a.reason);
    }
    return { outlet: a.outlet, distanceKm: a.distanceKm };
  }

  /** Price a cart against the server-side menu. */
  function quote({ outletId, items, fulfilment, distanceKm }) {
    return priceCart(menuFor(outletId), items, fulfilment, distanceKm);
  }

  function newCode() {
    // Unambiguous characters only (no 0/O/1/I).
    const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    for (;;) {
      const bytes = crypto.randomBytes(6);
      const code = brand().codePrefix + [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
      if (!store.orderCodeExists(code)) return code;
    }
  }

  /**
   * Create an order. Input:
   * { channel, fulfilment, name, phone, address?, lat?, lng?, outletId?, notes?, items: [{id, qty, note?}],
   *   paymentMethod?: 'cod' | 'upi' }
   */
  function createOrder(input, now = new Date()) {
    const fulfilment = input.fulfilment === 'pickup' ? 'pickup' : 'delivery';
    const name = String(input.name || '').trim().slice(0, 80);
    const phone = normalisePhone(input.phone);
    const address = String(input.address || '').trim().slice(0, 300);
    const notes = String(input.notes || '').trim().slice(0, 300);
    const lat = input.lat === undefined || input.lat === null ? NaN : Number(input.lat);
    const lng = input.lng === undefined || input.lng === null ? NaN : Number(input.lng);
    if (!name) throw new ValidationError('Please enter your name.');
    if (!phone) throw new ValidationError('Please enter a valid 10-digit mobile number.');
    if (fulfilment === 'delivery' && address.length < 5) throw new ValidationError('Please enter your full delivery address.');

    const { outlet, distanceKm } = resolveOutlet({ fulfilment, lat, lng, outletId: Number(input.outletId) || null }, now);
    const priced = quote({ outletId: outlet.id, items: input.items, fulfilment, distanceKm });
    if (fulfilment === 'delivery' && priced.subtotal < config.pricing.minDeliveryOrder) {
      throw new ValidationError(`Minimum order for delivery is ₹${config.pricing.minDeliveryOrder / 100}.`, 'min_order');
    }

    const payUpi = input.paymentMethod === 'upi';
    if (payUpi && !canPayOnline(outlet)) throw new ValidationError(`${outlet.name} doesn't take UPI payments online yet. Please choose cash/UPI on ${fulfilment}.`, 'no_upi');

    const code = newCode();
    const ts = now.toISOString();
    store.insertOrder({
      code, outlet_id: outlet.id, channel: input.channel === 'whatsapp' ? 'whatsapp' : 'web', fulfilment,
      customer_name: name, phone, address: fulfilment === 'delivery' ? address : null,
      lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null, distance_km: distanceKm,
      notes: notes || null, subtotal: priced.subtotal, packing: priced.packing, gst: priced.gst,
      delivery_fee: priced.deliveryFee, total: priced.total, payment_method: payUpi ? 'upi' : 'cod', payment_status: payUpi ? 'pending' : 'cod', status: payUpi ? 'awaiting_payment' : 'placed',
      created_at: ts, updated_at: ts,
    }, priced.lines);
    // Take the dishes out of the outlet's stock count (no-op for items without a count).
    for (const l of priced.lines) store.adjustStock(outlet.id, l.item_id, -l.qty, ts);
    const order = getOrder(code);
    store.addOrderEvent(order.id, order.status, ts);
    // The customer's marketing consent travels with the event to the CRM.
    events.emit('created', { ...order, marketingOptIn: !!input.marketingOptIn });
    return order;
  }

  function present(row) {
    if (!row) return null;
    const outlet = getOutlet(row.outlet_id);
    return {
      ...row,
      items: store.orderLines(row.id),
      statusLabel: STATUS_LABELS[row.status],
      nextStatuses: (TRANSITIONS[row.fulfilment][row.status] || []),
      etaMinutes: etaMinutes(row.fulfilment, row.distance_km || 0),
      outlet: outlet && { id: outlet.id, name: outlet.name, phone: outlet.phone, address: outlet.address, lat: outlet.lat, lng: outlet.lng },
      // A cancelled order still showing paid is waiting for its refund (retried automatically).
      paymentLabel: row.status === 'cancelled' && row.payment_status === 'paid' ? 'Paid, refund pending' : PAYMENT_LABELS[row.payment_status],
      delivery: presentDelivery(row),
      // Gateway: our /pay/<code> page (UPI, QR, cards; confirms itself). Otherwise
      // a upi:// request straight to the outlet's UPI ID (staff confirm).
      upi: row.payment_method !== 'upi' ? null : gatewayOn() ? {
        gateway: true, upiId: null, payee: brand().name, link: `${config.publicBaseUrl}/pay/${row.code}`,
      } : upiFor(outlet) ? {
        upiId: upiFor(outlet).id,
        payee: upiFor(outlet).name,
        link: upiLink({ upiId: upiFor(outlet).id, payee: upiFor(outlet).name, amountPaise: row.total, code: row.code }),
      } : null,
    };
  }

  // Payment: pending -> claimed (customer says paid) -> paid (outlet confirms).
  // Staff can also bounce a claim back to pending, or switch to cash.
  const PAYMENT_TRANSITIONS = {
    pending: ['claimed', 'paid', 'cod'],
    claimed: ['paid', 'pending', 'cod'],
    // A WhatsApp/UPI payment can still land after the customer chose cash.
    cod: ['paid'],
    // Gateway refund after the outlet cancelled a paid order.
    paid: ['refunded'],
  };

  // by: 'staff' (dashboard), 'customer' (WhatsApp/web) or 'gateway' (future
  // payment-gateway webhook). Listeners use it to avoid echoing the customer.
  function setPayment(code, next, now = new Date(), by = 'staff') {
    const order = getOrder(code);
    if (!order) return null;
    if (order.status === 'unpaid' && next !== 'paid') {
      throw new ValidationError(`Order ${order.code} wasn't paid in time and was cancelled. Please order again.`, 'expired');
    }
    if (!(PAYMENT_TRANSITIONS[order.payment_status] || []).includes(next)) {
      throw new ValidationError(`Payment is already "${order.paymentLabel}".`, 'bad_payment_transition');
    }
    if (!store.setPaymentStatus(order.id, order.payment_status, next, now.toISOString())) {
      throw new ValidationError('Order was updated by someone else. Refresh and try again.', 'conflict');
    }
    let updated = getOrder(code);
    // Paid, or switched to cash: a waiting (or just expired) order now goes to the kitchen.
    // Cash on an expired order doesn't bring it back; a late payment does.
    const confirm = (updated.status === 'awaiting_payment' && ['paid', 'cod'].includes(next)) || (updated.status === 'unpaid' && next === 'paid');
    if (confirm) updated = moveStatus(updated, 'placed', now, { by: 'payment', revived: updated.status === 'unpaid' });
    // confirmed: this payment change sent the order to the kitchen (listeners tell the customer).
    events.emit('payment', updated, order.payment_status, by, { confirmed: confirm });
    return updated;
  }

  /** Cancel UPI orders still unpaid after the payment window (not ones the customer says are paid). */
  function expireUnpaid(now = new Date()) {
    const cutoff = new Date(now.getTime() - config.payments.windowMinutes * 60000).toISOString();
    return store.unpaidBefore(cutoff).map((row) => moveStatus(getOrder(row.code), 'unpaid', now, { by: 'system' }));
  }

  /** Customer says they've paid. Idempotent. */
  function claimPayment(code, now = new Date()) {
    const o = getOrder(code);
    if (o && o.payment_status === 'claimed') return o;
    return setPayment(code, 'claimed', now, 'customer');
  }

  function presentDelivery(row) {
    const d = store.getDelivery(row.id);
    if (!d) return null;
    return {
      ...d, label: DELIVERY_LABELS[d.status] || d.status, collect: row.payment_status === 'paid' ? 0 : row.total,
      providerLabel: PROVIDER_LABELS[d.provider] || d.provider, quotes: parseJson(d.quotes, []), tried: parseJson(d.tried, []),
    };
  }

  const getOrderById = (id) => present(store.orderById(id));
  const getOrder = (code) => present(store.orderByCode(String(code || '').toUpperCase()));

  function latestOrderForPhone(raw) {
    const phone = normalisePhone(raw);
    return phone ? present(store.latestOrderForPhone(phone)) : null;
  }

  function listOrders({ outletId, statuses, limit = 100 } = {}) {
    return store.listOrders({ outletId, statuses, limit: Math.min(Number(limit) || 100, 500) }).map(present);
  }

  // meta: { by?: 'staff' | 'delivery', quiet?: true } is passed on to listeners.
  function updateStatus(code, next, now = new Date(), meta = {}) {
    const order = getOrder(code);
    if (!order) return null;
    if (!order.nextStatuses.includes(next)) {
      throw new ValidationError(`Cannot move order from "${order.status}" to "${next}".`, 'bad_transition');
    }
    return moveStatus(order, next, now, meta);
  }

  // Status change without the staff transition rules (payment and expiry use it directly).
  function moveStatus(order, next, now, meta = {}) {
    const code = order.code;
    if (!store.setOrderStatus(order.id, order.status, next, now.toISOString())) throw new ValidationError('Order was updated by someone else. Refresh and try again.', 'conflict');
    store.addOrderEvent(order.id, next, now.toISOString());
    // A cancelled or unpaid order's dishes go back into the outlet's stock count;
    // a late payment for an expired order takes them again.
    if (meta.revived) for (const l of order.items) store.adjustStock(order.outlet_id, l.item_id, -l.qty, now.toISOString());
    if (next === 'cancelled' || next === 'unpaid') for (const l of order.items) store.adjustStock(order.outlet_id, l.item_id, l.qty, now.toISOString());
    const updated = getOrder(code);
    events.emit('status', updated, { ...meta, from: order.status });
    return updated;
  }

  return {
    events, listOutlets, getOutlet, menuFor, categories, resolveOutlet, quote, createOrder, getOrder, getOrderById,
    latestOrderForPhone, listOrders, updateStatus, setPayment, claimPayment, expireUnpaid,
  };
}

module.exports = {
  createOrderService, priceCart, ValidationError, normalisePhone, canPayOnline, STATUSES, NOT_SALES, STATUS_LABELS, TRANSITIONS, deliveryFee, deliveryCharge, DELIVERY_LABELS,
};
