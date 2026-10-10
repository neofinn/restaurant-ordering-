'use strict';

// Pretend delivery partners for demos, local development and tests. Each one
// quotes a price, sometimes has no rider, and replays a rider moving from the
// outlet to the customer (compressed: about a minute end to end).
//
// createSimulatedShadowfax: one partner that sends Shadowfax-format callbacks.
// createSimulatedFleet: Shadowfax, Porter and Borzo look-alikes with different
// prices and rider availability, for the smart selector.

const RIDERS = [
  ['Gurpreet Singh', '9876500011'], ['Amit Kumar', '9876500022'], ['Rohit Sharma', '9876500033'],
  ['Manpreet Kaur', '9876500044'], ['Sandeep Rana', '9876500055'], ['Vikas Thakur', '9876500066'],
];

/**
 * One simulated partner. emit(update) receives normalised updates
 * ({ ref, clientOrderId, status, rider, trackUrl, error }).
 * pricing(km) -> paise; noRider: chance (0-1) that nobody accepts.
 */
function createSimulatedPartner({
  name, label, supportsCod = true, pricing, noRider = 0, assignMs = 3000, emit, speed = 1, schedule = setTimeout, random = Math.random,
}) {
  let n = 0;
  const cancelled = new Set();
  const at = (ms, fn) => schedule(fn, ms / speed);

  return {
    name,
    label,
    simulated: true,
    supportsCod,
    ready: () => true,

    async quote(order) {
      return { ok: true, price: pricing(order.distance_km || 0), etaMin: Math.round(assignMs / 1000) };
    },

    async book(order, outlet) {
      const ref = `${name.slice(0, 3).toUpperCase()}${100000 + ++n}`;
      const [riderName, riderPhone] = RIDERS[(n + name.length) % RIDERS.length];
      const send = (status, extra = {}) => {
        if (cancelled.has(ref)) return;
        emit({ ref, clientOrderId: order.code, status, trackUrl: `https://example.com/${name}/track/${ref}`, rider: null, error: null, ...extra });
      };
      // Sometimes no rider takes the job: the dispatcher's sweep moves it to the next partner.
      if (random() < noRider) return { ref, status: 'ACCEPTED', trackUrl: null, rider: null };

      const rider = (p) => ({ rider: { name: riderName, phone: riderPhone, lat: p.lat, lng: p.lng } });
      const start = { lat: outlet.lat + 0.01, lng: outlet.lng - 0.012 };
      const drop = { lat: order.lat, lng: order.lng };
      const lerp = (a, b, t) => ({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
      let status = 'ACCEPTED';
      const step = (ms, s, p) => at(ms, () => { status = s; send(s, rider(p)); });
      const moveTo = (from, to, startMs, durMs, steps) => {
        for (let i = 1; i <= steps; i++) at(startMs + (durMs * i) / steps, () => send(status, rider(lerp(from, to, i / steps))));
      };
      const t0 = assignMs;
      step(t0, 'ALLOTTED', start);
      moveTo(start, outlet, t0, 7000, 4);
      step(t0 + 7500, 'ARRIVED', outlet);
      step(t0 + 15000, 'DISPATCHED', outlet);
      moveTo(outlet, drop, t0 + 15000, 24000, 10);
      step(t0 + 39500, 'ARRIVED_CUSTOMER_DOORSTEP', drop);
      step(t0 + 45000, 'DELIVERED', drop);
      return { ref, status: 'ACCEPTED', trackUrl: `https://example.com/${name}/track/${ref}`, rider: null };
    },

    async cancel(ref) { cancelled.add(ref); return { message: 'Cancelled' }; },
    parseCallback: (u) => u,
  };
}

/** Shadowfax look-alike that calls back with Shadowfax-format payloads. */
function createSimulatedShadowfax({ onCallback, speed = 1, schedule = setTimeout }) {
  const toSfx = (u) => ({
    sfx_order_id: u.ref, client_order_id: u.clientOrderId, order_status: u.status, track_url: u.trackUrl,
    ...(u.rider ? { rider_name: u.rider.name, rider_contact: u.rider.phone, rider_latitude: u.rider.lat, rider_longitude: u.rider.lng } : {}),
  });
  const p = createSimulatedPartner({
    name: 'shadowfax', label: 'Shadowfax', pricing: () => 4000, emit: (u) => onCallback(toSfx(u)), speed, schedule, random: () => 1,
  });
  return p;
}

/**
 * Three partners with different prices and reliability (rates loosely follow
 * the published/contract figures: Borzo ₹45 + ₹8.5/km; Porter from ₹48;
 * Shadowfax per our rate card). onUpdate(name, update).
 */
function createSimulatedFleet({ onUpdate, speed = 1, schedule = setTimeout, random = Math.random, noRider = { shadowfax: 0.15, porter: 0.1, borzo: 0.25 } }) {
  const km = (d) => Math.max(0, d);
  const make = (name, label, supportsCod, pricing, assignMs) => createSimulatedPartner({
    name, label, supportsCod, pricing, assignMs, noRider: noRider[name] || 0, speed, schedule, random, emit: (u) => onUpdate(name, u),
  });
  return [
    make('shadowfax', 'Shadowfax', true, (d) => 4000 + Math.ceil(Math.max(0, km(d) - 3)) * 1000, 3000),
    make('porter', 'Porter', false, (d) => 4800 + Math.ceil(Math.max(0, km(d) - 1)) * 900, 4000),
    make('borzo', 'Borzo', true, (d) => 4500 + Math.round(km(d) * 850), 6000),
  ];
}

module.exports = { createSimulatedShadowfax, createSimulatedPartner, createSimulatedFleet };
