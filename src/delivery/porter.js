'use strict';

// Porter (porter.in) API client: two-wheeler deliveries, prepaid only (no cash
// on delivery through the API). Credentials via porter.in/api-integrations.
//
// Porter's API contract (porter-logistics.notion.site, "Porter API Contract")
// has Get Quote (price per vehicle, or "unserviceable"), Create Order, Track,
// Cancel and webhooks (accepted, live, ended, cancelled, reopened), with a UAT
// host (pfe-apigw-uat.porter.in) and a lifecycle simulator. The paths, header
// and field names below follow the published request shapes; CONFIRM them
// against the contract in UAT before going live. Paths and the key header can
// be overridden via config.porter.

const DEFAULT_PATHS = {
  quote: '/v1/get_quote',
  create: '/v1/orders/create',
  track: '/v1/orders/{id}',
  cancel: '/v1/orders/{id}/cancel',
};

const digits10 = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);

const { brand } = require('../brand');

class PorterError extends Error {}

const address = (name, line, city, lat, lng, phone) => ({
  apartment_address: name,
  street_address1: line,
  city,
  state: brand().region.state,
  country: 'India',
  lat,
  lng,
  contact_details: { name, phone_number: `+91${digits10(phone)}` },
});

/** Porter create-order body. request_id must be unique per attempt. */
function buildPorterOrder(order, outlet, attempt = 1) {
  return {
    request_id: `${order.code}-${attempt}`,
    delivery_instructions: { instructions_list: [{ type: 'text', description: `${brand().name} order ${order.code}. Food, keep upright.` }] },
    pickup_details: { address: address(outlet.name, outlet.address, outlet.city, outlet.lat, outlet.lng, outlet.phone) },
    drop_details: { address: address(order.customer_name, order.address, outlet.city, order.lat, order.lng, order.phone) },
  };
}

// Porter webhook events -> our delivery statuses. "live" = rider picked up and riding.
const STATUS = { open: 'ACCEPTED', reopened: 'ACCEPTED', accepted: 'ALLOTTED', live: 'DISPATCHED', ended: 'DELIVERED', completed: 'DELIVERED', cancelled: 'CANCELLED' };

function parsePorterCallback(body) {
  const raw = String(body.status || body.event || body.order_status || '').toLowerCase().replace(/^order_/, '');
  const p = body.partner_info || body.driver || null;
  const loc = p?.location || body.partner_location || null;
  const status = STATUS[raw] || null;
  return {
    ref: String(body.order_id ?? body.crn ?? ''),
    clientOrderId: body.request_id ? String(body.request_id).replace(/-\d+$/, '') : null,
    status,
    rider: p ? {
      name: p.name || null,
      phone: p.mobile?.mobile_number || p.mobile_number || p.mobile || null,
      lat: loc?.lat != null ? Number(loc.lat) : null,
      lng: loc?.long != null ? Number(loc.long) : loc?.lng != null ? Number(loc.lng) : null,
    } : null,
    trackUrl: body.tracking_url || null,
    error: status === 'CANCELLED' ? (body.cancel_reason || 'Porter cancelled the delivery') : null,
  };
}

function createPorterClient({ apiKey, baseUrl = 'https://pfe-apigw-uat.porter.in', paths = {}, keyHeader = 'x-api-key', fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
  const p = { ...DEFAULT_PATHS, ...paths };
  let attempts = 0;

  async function call(method, path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(baseUrl.replace(/\/$/, '') + path, {
        method,
        headers: { [keyHeader]: apiKey, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new PorterError(`Porter ${res.status}: ${data.message || data.error || 'request failed'}`);
      return data;
    } catch (e) {
      if (e.name === 'AbortError') throw new PorterError('Porter did not respond in time');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: 'porter',
    label: 'Porter',
    supportsCod: false,
    ready: () => true,

    async quote(order, outlet) {
      const r = await call('POST', p.quote, {
        pickup_details: { lat: outlet.lat, lng: outlet.lng },
        drop_details: { lat: order.lat, lng: order.lng },
        customer: { name: order.customer_name, mobile: { country_code: '+91', number: digits10(order.phone) } },
      });
      const vehicles = r.vehicles || r.data?.vehicles || [];
      const bike = vehicles.find((v) => /2\s*wheeler|two.?wheeler|bike/i.test(v.type || v.vehicle_type || ''));
      if (!bike) return { ok: false, reason: 'Porter: no two-wheeler for this route' };
      const fare = bike.fare || {};
      const price = fare.minor_amount != null ? Number(fare.minor_amount) : Math.round(Number(fare.amount ?? bike.fare) * 100);
      const eta = bike.eta?.value ?? bike.eta;
      return Number.isFinite(price) ? { ok: true, price, etaMin: Number.isFinite(Number(eta)) ? Number(eta) : null } : { ok: false, reason: 'Porter: no price returned' };
    },

    async book(order, outlet) {
      const r = await call('POST', p.create, buildPorterOrder(order, outlet, ++attempts));
      const id = r.order_id || r.data?.order_id;
      if (!id) throw new PorterError(`Porter did not create the order: ${r.message || 'no order id'}`);
      const fare = r.estimated_fare_details || {};
      return {
        ref: String(id),
        status: 'ACCEPTED',
        trackUrl: r.tracking_url || null,
        price: fare.minor_amount != null ? Number(fare.minor_amount) : null,
        rider: null,
      };
    },

    cancel: (ref) => call('POST', p.cancel.replace('{id}', encodeURIComponent(ref))),
    parseCallback: parsePorterCallback,
  };
}

module.exports = { createPorterClient, buildPorterOrder, parsePorterCallback, PorterError, DEFAULT_PATHS };
