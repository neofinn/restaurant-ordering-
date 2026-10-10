'use strict';

// Places a typed address on the map without a maps API, by matching known
// areas (localities table from the client profile, e.g. Chandigarh sectors, Mohali phases, Panchkula
// sectors, towns). Accurate to the area, which is enough to pick the outlet
// and delivery charge; customers can share a pin for the exact drop point.
// For full street-level geocoding plug in a maps API later.

const norm = (s) => ` ${String(s).toLowerCase()
  .replace(/\(.*?\)/g, ' ')
  .replace(/\bsec(?:tor)?\.?\s*-?\s*(\d)/g, 'sector $1')
  .replace(/\bph(?:ase)?\.?\s*-?\s*(\d)/g, 'phase $1')
  .replace(/\bchd\b/g, 'chandigarh')
  .replace(/\b(sas nagar|mohali)\b/g, 'mohali')
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()} `;

/**
 * Match an address to known localities.
 * Returns { place } for one clear match, { candidates } when several areas
 * fit (e.g. "Sector 20" exists in Chandigarh and Panchkula), or {} if none.
 */
function placeAddress(address, localities) {
  const text = norm(address);
  const hits = localities
    .map((l) => ({ l, key: norm(l.name).trim() }))
    // Whole-phrase match: "sector 2" must not match "sector 22".
    .filter(({ key }) => key && text.includes(` ${key} `))
    .map(({ l, key }) => ({ l, score: key.length + (text.includes(` ${norm(l.city).trim()} `) ? 100 : 0) }));
  if (!hits.length) return {};
  const best = Math.max(...hits.map((h) => h.score));
  const top = hits.filter((h) => h.score === best).map((h) => h.l);
  return top.length === 1 ? { place: top[0] } : { candidates: top.slice(0, 3) };
}

module.exports = { placeAddress };
