'use strict';

// Borzo (formerly WeFast) Business API v1.8 client. Docs:
// https://borzodelivery.com/in/business-api/doc
//
// - Auth: X-DV-Auth-Token header. Test: robotapitest-in.borzodelivery.com,
//   production: robot-in.borzodelivery.com (enabled by Borzo after testing).
// - calculate-order gives the price (and warnings when a point can't be served),
//   create-order books a motorbike courier (vehicle_type_id 8), cancel-order cancels.
// - Cash on delivery: the drop point's taking_amount is collected by the courier.
// - Callbacks: POST JSON {event_type, event_datetime, order | delivery}, signed
//   with HMAC-SHA256 of the body using the Callback Secret Key (X-DV-Signature).
//   Confirm the signature encoding against a live test callback.

const crypto = require('node:crypto');

const digits10 = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);
const rupeeText = (paise) => (Math.round(paise) / 100).toFixed(2);

class BorzoError extends Error {}

/** Borzo order body for one of our orders. */
function buildBorzoOrder(order, outlet) {
  const unpaid = order.payment_status !== 'paid';
  return {
    matter: 'Food',
    vehicle_type_id: 8, // motorbike
    total_weight_kg: 2,
    points: [
      {
        address: `${outlet.name}, ${outlet.address}`,
        latitude: outlet.lat,
        longitude: outlet.lng,
        contact_person: { phone: digits10(outlet.phone), name: outlet.name },
        note: `Pick up order ${order.code}`,
      },
      {
        address: order.address,
        latitude: order.lat,
        longitude: order.lng,
        contact_person: { phone: digits10(order.phone), name: order.customer_name },
        client_order_id: order.code,
        // Rider collects the order total at the door when it isn't paid yet.
        taking_amount: unpaid ? rupeeText(order.total) : '0.00',
        note: order.notes || undefined,
      },
    ],
  };
}

// Borzo order / delivery statuses -> our delivery statuses (orders.js DELIVERY_LABELS).
const ORDER_STATUS = { new: 'ACCEPTED', available: 'ACCEPTED', reactivated: 'ACCEPTED', delayed: 'ACCEPTED', active: 'ALLOTTED', completed: 'DELIVERED', canceled: 'CANCELLED' };
const DELIVERY_STATUS = {
  planned: 'ACCEPTED', delayed: 'ACCEPTED', courier_assigned: 'ALLOTTED', courier_departed: 'ALLOTTED', courier_at_pickup: 'ARRIVED',
  parcel_picked_up: 'DISPATCHED', active: 'DISPATCHED', courier_arrived: 'ARRIVED_CUSTOMER_DOORSTEP', finished: 'DELIVERED', canceled: 'CANCELLED',
};

/** A Borzo callback body -> our normalised update (see dispatcher.handleUpdate). */
function parseBorzoCallback(body) {
  const order = body.order || null;
  const delivery = body.delivery || null;
  const courier = order?.courier || delivery?.courier || null;
  const status = delivery ? DELIVERY_STATUS[delivery.status] : order ? ORDER_STATUS[order.status] : null;
  return {
    ref: String(order?.order_id ?? delivery?.order_id ?? ''),
    clientOrderId: delivery?.client_order_id || order?.points?.find((p) => p.client_order_id)?.client_order_id || null,
    status: status || null,
    rider: courier ? {
      name: [courier.name, courier.surname].filter(Boolean).join(' ') || null,
      phone: courier.phone || null,
      lat: courier.latitude != null ? Number(courier.latitude) : null,
      lng: courier.longitude != null ? Number(courier.longitude) : null,
    } : null,
    trackUrl: delivery?.tracking_url || order?.points?.at(-1)?.tracking_url || null,
    error: status === 'CANCELLED' ? 'Borzo cancelled the delivery' : null,
  };
}

function validBorzoSignature(rawBody, header, secret) {
  if (!secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody || '').digest('hex');
  const got = String(header || '');
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

function createBorzoClient({ token, baseUrl = 'https://robotapitest-in.borzodelivery.com/api/business/1.8', fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
  async function call(path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/${path}`, {
        method: 'POST',
        headers: { 'X-DV-Auth-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.is_successful === false) {
        const why = [...(data.errors || []), ...Object.keys(data.parameter_errors || {})].join(', ');
        throw new BorzoError(`Borzo ${res.status}: ${why || 'request failed'}`);
      }
      return data;
    } catch (e) {
      if (e.name === 'AbortError') throw new BorzoError('Borzo did not respond in time');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: 'borzo',
    label: 'Borzo',
    supportsCod: true,
    ready: () => true,

    /** { ok, price (paise), etaMin, reason } */
    async quote(order, outlet) {
      const r = await call('calculate-order', buildBorzoOrder(order, outlet));
      const warnings = [...(r.warnings || []), ...Object.keys(r.parameter_warnings || {})];
      if (warnings.length) return { ok: false, reason: `Borzo: ${warnings.join(', ')}` };
      return { ok: true, price: Math.round(Number(r.order.payment_amount) * 100), etaMin: null };
    },

    async book(order, outlet) {
      const r = await call('create-order', buildBorzoOrder(order, outlet));
      const o = r.order || {};
      if (!o.order_id) throw new BorzoError('Borzo did not create the order');
      const c = o.courier;
      return {
        ref: String(o.order_id),
        status: c ? 'ALLOTTED' : 'ACCEPTED',
        trackUrl: o.points?.at(-1)?.tracking_url || null,
        price: o.payment_amount != null ? Math.round(Number(o.payment_amount) * 100) : null,
        rider: c ? { name: [c.name, c.surname].filter(Boolean).join(' '), phone: c.phone || null } : null,
      };
    },

    cancel: (ref) => call('cancel-order', { order_id: Number(ref) }),
    parseCallback: parseBorzoCallback,
  };
}

module.exports = { createBorzoClient, buildBorzoOrder, parseBorzoCallback, validBorzoSignature, BorzoError };
