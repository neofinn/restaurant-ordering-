'use strict';

// Head office adds new outlets and edits outlet details. A new outlet starts
// taking orders straight away: routing picks it for customers it is nearest
// to, every dish is in stock (until head office changes it), and its tablet
// can log in once head office sets its PIN.

const config = require('./config');
const { ValidationError, normalisePhone } = require('./orders');
const { haversineKm } = require('./geo');
const { brand, fullName, shortName } = require('./brand');

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const UPI = /^[a-z0-9._-]{2,}@[a-z][a-z0-9.-]{1,}$/i;

/** Pull coordinates out of a Google Maps link: ".../@30.7,76.7,17z", "?q=30.7,76.7", "!3d30.7!4d76.7". */
function coordsFromMapsLink(link) {
  const s = decodeURIComponent(String(link || ''));
  const m = s.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || s.match(/[@?&=](-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/)
    || s.match(/^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/);
  return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
}

const slugify = (s) => shortName(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'outlet';

function createOutletAdmin({ store }) {
  // Validates the fields that were sent; `required` for a new outlet.
  function clean(body, { required }) {
    const out = {};
    const text = (k, max, label) => {
      if (body[k] === undefined && !required) return;
      const v = String(body[k] ?? '').trim().slice(0, max);
      if (!v) throw new ValidationError(`${label} is required.`);
      return v;
    };
    const opt = (k, max) => (body[k] === undefined ? undefined : String(body[k] ?? '').trim().slice(0, max) || null);

    const name = text('name', 80, 'Outlet name');
    if (name !== undefined) out.name = fullName(name);
    const city = text('city', 40, 'City');
    if (city !== undefined) out.city = city;
    const address = text('address', 200, 'Address');
    if (address !== undefined) out.address = address;

    if (body.phone !== undefined || required) {
      // A mobile, or a landline such as 0172 2345678.
      const raw = String(body.phone ?? '').trim();
      const phone = normalisePhone(raw) || (/^\+?[\d\s-]{8,16}$/.test(raw) && raw.replace(/\D/g, '').length >= 8 ? raw.replace(/\s+/g, ' ') : null);
      if (!phone) throw new ValidationError('Enter the outlet phone number (mobile or landline).');
      out.phone = phone;
    }

    let { lat, lng } = body;
    if (body.mapsLink) {
      const c = coordsFromMapsLink(body.mapsLink);
      if (!c && /goo\.gl|maps\.app/.test(body.mapsLink)) {
        throw new ValidationError('Short Maps links have no location in them. Open the link, then copy the full address from the browser bar (it contains @30.7…,76.7…), or type latitude and longitude.');
      }
      if (!c) throw new ValidationError("Couldn't read a location from that link. Paste a Google Maps link, or type latitude and longitude.");
      ({ lat, lng } = c);
    }
    if (lat !== undefined || lng !== undefined || required) {
      lat = Number(lat); lng = Number(lng);
      // The client's region (India if not set); catches swapped or mistyped numbers.
      const { region } = brand();
      const b = region.bounds || { minLat: 6, maxLat: 37.5, minLng: 68, maxLng: 97.5 };
      if (!(lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng)) {
        const about = (lo, hi) => `${Math.floor((lo + hi) / 2)}.x`;
        throw new ValidationError(`Location looks wrong: latitude should be about ${about(b.minLat, b.maxLat)} and longitude about ${about(b.minLng, b.maxLng)}${region.bounds ? ` for ${region.name}` : ''}.`);
      }
      out.lat = Math.round(lat * 1e6) / 1e6;
      out.lng = Math.round(lng * 1e6) / 1e6;
    }

    for (const k of ['opens', 'closes']) {
      if (body[k] === undefined && !required) continue;
      const v = String(body[k] ?? (k === 'opens' ? '11:00' : '23:00')).trim();
      if (!TIME.test(v)) throw new ValidationError(`${k === 'opens' ? 'Opening' : 'Closing'} time must look like 11:00 (24-hour).`);
      out[k] = v;
    }

    const upi = opt('upiId', 60);
    if (upi !== undefined) {
      if (upi && !UPI.test(upi)) throw new ValidationError('UPI ID must look like name@bank.');
      out.upi_id = upi;
    }
    const sfx = opt('sfxStoreCode', 40);
    if (sfx !== undefined) out.sfx_store_code = sfx;
    const wa = opt('waPaymentConfig', 60);
    if (wa !== undefined) out.wa_payment_config = wa;
    return out;
  }

  /** Nearest other outlet, so head office can spot a pin in the wrong place. */
  function nearestOther(id, { lat, lng }) {
    let best = null;
    for (const o of store.outlets()) {
      if (o.id === id) continue;
      const km = haversineKm({ lat, lng }, o);
      if (!best || km < best.km) best = { name: o.name, km: Math.round(km * 10) / 10 };
    }
    return best;
  }

  function add(body) {
    const o = clean(body || {}, { required: true });
    const taken = new Set(store.allOutlets().map((x) => x.slug));
    let slug = slugify(o.name);
    for (let n = 2; taken.has(slug); n++) slug = `${slugify(o.name)}-${n}`;
    if (store.allOutlets().some((x) => x.name.toLowerCase() === o.name.toLowerCase())) {
      throw new ValidationError(`There is already an outlet called "${o.name}".`);
    }
    const id = store.insertOutlet({
      slug, upi_id: null, sfx_store_code: null, wa_payment_config: null, ...o,
      delivery_radius_km: config.delivery.rangeKm, upi_name: brand().name,
      accepting_orders: body.acceptingOrders === false ? 0 : 1, active: 1,
    });
    return { outlet: store.outlet(id), nearest: nearestOther(id, o) };
  }

  function update(id, body) {
    const current = store.outlet(id);
    if (!current) return null;
    const fields = clean(body || {}, { required: false });
    if (fields.name && store.allOutlets().some((x) => x.id !== current.id && x.name.toLowerCase() === fields.name.toLowerCase())) {
      throw new ValidationError(`There is already an outlet called "${fields.name}".`);
    }
    store.updateOutlet(current.id, fields);
    if (typeof body.acceptingOrders === 'boolean') store.setAccepting(current.id, body.acceptingOrders);
    const outlet = store.outlet(current.id);
    return fields.lat !== undefined ? { ...outlet, nearest: nearestOther(outlet.id, outlet) } : outlet;
  }

  return { add, update };
}

module.exports = { createOutletAdmin, coordsFromMapsLink };
