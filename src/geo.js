'use strict';

const config = require('./config');

const EARTH_RADIUS_KM = 6371;
const toRad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in km. */
function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/**
 * Road distance is typically ~1.3x straight-line distance in a city road grid.
 * Used for radius checks, fees and ETAs so we don't over-promise.
 */
const ROAD_FACTOR = 1.3;
const roadKm = (a, b) => Math.round(haversineKm(a, b) * ROAD_FACTOR * 10) / 10;

// Building an Intl formatter is slow, and this runs for every outlet on every
// request: keep one per time zone.
const formatters = new Map();
function minutesNow(now, timezone = config.timezone) {
  if (!formatters.has(timezone)) {
    formatters.set(timezone, new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  }
  const parts = formatters.get(timezone).formatToParts(now);
  const get = (t) => parseInt(parts.find((p) => p.type === t).value, 10);
  return get('hour') * 60 + get('minute');
}

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/**
 * Whether an outlet is open and taking orders. Handles closing after midnight;
 * equal opening and closing times mean open 24 hours.
 */
function isOpen(outlet, now = new Date()) {
  if (!outlet.active || !outlet.accepting_orders) return false;
  const t = minutesNow(now);
  const open = toMinutes(outlet.opens);
  const close = toMinutes(outlet.closes);
  if (open === close) return true;
  return open <= close ? t >= open && t < close : t >= open || t < close;
}

/**
 * Rank outlets for a customer location and pick the one that should serve it.
 *
 * Delivery: nearest outlet that is open AND has the customer within its
 * delivery radius. Pickup: nearest open outlet.
 *
 * Returns { outlet, distanceKm, reason, ranked } where outlet is null when no
 * outlet can serve the request; reason is then 'out_of_range' or 'closed'.
 * `pickupSuggestion` is the nearest open outlet, useful as a fallback offer.
 */
function assignOutlet(outlets, location, { fulfilment = 'delivery', now = new Date() } = {}) {
  const ranked = outlets
    .filter((o) => o.active)
    .map((o) => {
      const distanceKm = roadKm(location, o);
      return { outlet: o, distanceKm, open: isOpen(o, now), inRange: distanceKm <= rangeKm(o) };
    })
    .sort((a, b) => a.distanceKm - b.distanceKm);

  const pickup = ranked.find((r) => r.open) || null;
  const pickupSuggestion = pickup && { outlet: pickup.outlet, distanceKm: pickup.distanceKm };

  if (fulfilment === 'pickup') {
    return pickup
      ? { outlet: pickup.outlet, distanceKm: pickup.distanceKm, reason: null, ranked, pickupSuggestion }
      : { outlet: null, distanceKm: null, reason: 'closed', ranked, pickupSuggestion };
  }

  const best = ranked.find((r) => r.inRange && r.open);
  if (best) return { outlet: best.outlet, distanceKm: best.distanceKm, reason: null, ranked, pickupSuggestion };
  const reason = ranked.some((r) => r.inRange) ? 'closed' : 'out_of_range';
  return { outlet: null, distanceKm: null, reason, ranked, pickupSuggestion };
}

/** Delivery range of an outlet (road km). The chain-wide maximum applies to every outlet. */
const rangeKm = (o) => config.delivery?.rangeKm || o.delivery_radius_km;

/** Rough ETA: prep time plus ~3 min per km of riding. */
function etaMinutes(fulfilment, distanceKm) {
  const prep = 20;
  if (fulfilment === 'pickup') return prep;
  return Math.round((prep + 5 + distanceKm * 3) / 5) * 5;
}

module.exports = { haversineKm, roadKm, isOpen, assignOutlet, etaMinutes, minutesNow, rangeKm };
