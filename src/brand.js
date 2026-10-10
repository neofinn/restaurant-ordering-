'use strict';

// Which client this install runs for. Everything that names or styles the
// business (and its starting outlets, menu and localities) lives in a client
// profile, clients/<id>/: brand.json plus data. Choose one with CLIENT=<id>
// (or a path to a profile folder). Nothing else in the code names a client.

const loadProfile = require('./client-profile');

const DEFAULTS = {
  id: 'restaurant',
  name: 'Your Restaurant',
  logo: null, // [first word, highlighted rest]; from name if not set
  outletPrefix: null, // "<name> - "
  codePrefix: null, // start of order codes; initials of the name by default
  menuTitle: null, // header on the WhatsApp menu pictures; NAME by default
  emoji: '🍽️',
  orderExample: null, // a typed order shown in the WhatsApp welcome
  menuExample: null, // a shorter one for the foot of the menu pictures
  description: null,
  colors: { brand: '#d62828', brandDark: '#a61e1e', accent: '#f4a300', menu: '#C62A1F' },
  // Where the outlets are: words for messages, state for delivery partners,
  // and the box new outlet locations must fall in (catches typos).
  region: { name: 'the city', state: '', bounds: null },
  upiExample: 'yourbrand.outlet@okaxis',
  demo: { domain: 'order.example.com', address: '', outside: null, tryOrders: [] },
};

let profile = null;
let merged = null;

function withDefaults(b = {}) {
  const name = b.name || DEFAULTS.name;
  const [first, ...rest] = name.split(' ');
  return {
    ...DEFAULTS,
    ...b,
    name,
    logo: b.logo || [first, rest.join(' ')],
    outletPrefix: b.outletPrefix ?? `${name} - `,
    codePrefix: (b.codePrefix || name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3) || 'OD').toUpperCase(),
    menuTitle: b.menuTitle || name.toUpperCase(),
    description: b.description || `Order online from your nearest ${name}.`,
    colors: { ...DEFAULTS.colors, ...b.colors },
    region: { ...DEFAULTS.region, ...b.region },
    demo: { ...DEFAULTS.demo, ...b.demo },
  };
}

/** The active client profile: { brand, outlets, menu, localities }. */
function client() {
  if (!profile) useClient(loadProfile(globalThis.process?.env.CLIENT)); // no process in the browser demo
  return profile;
}

/** Switch client (tests, the browser demo). */
function useClient(p) {
  profile = p;
  merged = withDefaults(p.brand);
  return profile;
}

const brand = () => (client(), merged);

/** "Spice Route - Sector 15" -> "Sector 15". */
const shortName = (name) => {
  const p = brand().outletPrefix;
  return p && String(name || '').startsWith(p) ? String(name).slice(p.length) : String(name || '');
};
/** "Sector 15" -> "Spice Route - Sector 15". */
const fullName = (short) => (shortName(short) !== short ? short : brand().outletPrefix + short);

/** What the browser pages get (window.BRAND). */
const publicBrand = () => {
  const b = brand();
  return { id: b.id, name: b.name, logo: b.logo, outletPrefix: b.outletPrefix, emoji: b.emoji, region: { name: b.region.name }, upiExample: b.upiExample, demo: b.demo };
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Brand an HTML page: fills {{name}}, {{logo}}, {{description}}, {{id}} and {{orderExample}},
 * and adds window.BRAND plus the brand colours at the end of <head>
 * (after the stylesheets, so the colours win).
 */
function brandPage(html) {
  const b = brand();
  const json = JSON.stringify(publicBrand()).replace(/</g, '\\u003c');
  const head = `<script>window.BRAND=${json};BRAND.short=(n)=>{n=String(n||'');return BRAND.outletPrefix&&n.startsWith(BRAND.outletPrefix)?n.slice(BRAND.outletPrefix.length):n;};</script>`
    + `<style>:root{--brand:${b.colors.brand};--brand-dark:${b.colors.brandDark};--accent:${b.colors.accent}}</style>`;
  return html
    .replace(/\{\{name\}\}/g, () => esc(b.name))
    .replace(/\{\{logo\}\}/g, () => `${esc(b.logo[0])}${b.logo[1] ? ` <span>${esc(b.logo[1])}</span>` : ''}`)
    .replace(/\{\{description\}\}/g, () => esc(b.description))
    .replace(/\{\{id\}\}/g, () => esc(b.id))
    .replace(/\{\{orderExample\}\}/g, () => esc(b.orderExample || 'type your order the way you would say it'))
    .replace(/<\/head>/, () => `${head}\n</head>`);
}

module.exports = { brand, client, useClient, shortName, fullName, publicBrand, brandPage, withDefaults };
