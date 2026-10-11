'use strict';

// The restaurants on the platform: onboarding, details, head office logins.

const crypto = require('node:crypto');
const { ValidationError } = require('../orders');

const RESERVED = new Set(['www', 'admin', 'api', 'app', 'platform', 'static', 'assets', 'mail', 'help', 'support', 'status', 'webhooks']);
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;
const CHECKS = {
  gstin: [/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'GSTIN should be 15 characters, like 03ABCDE1234F1Z5.'],
  pan: [/^[A-Z]{5}\d{4}[A-Z]$/, 'PAN should be like ABCDE1234F.'],
  fssai: [/^\d{14}$/, 'FSSAI licence number is 14 digits.'],
  bank_ifsc: [/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC should be like HDFC0001234.'],
  bank_account: [/^\d{9,18}$/, 'Bank account number is 9 to 18 digits.'],
  route_account: [/^acc_[A-Za-z0-9]{8,20}$/, 'Razorpay linked account IDs look like acc_XXXXXXXXXXXXXX.'],
  contact_phone: [/^\+?\d{10,13}$/, 'Phone should be 10 digits (or +91…).'],
  email: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Email doesn\'t look right.'],
  custom_domain: [/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/, 'Domain should be like order.yourrestaurant.in.'],
  wa_phone_number_id: [/^\d{8,20}$/, 'WhatsApp phone number ID is the long number from Meta\'s API setup page.'],
};
const TEXT = ['name', 'legal_name', 'contact_name', 'bank_name'];
const UPPER = new Set(['gstin', 'pan', 'bank_ifsc']);
const LOWER = new Set(['custom_domain', 'email']);
const EDITABLE = [...TEXT, ...Object.keys(CHECKS), 'commission_pct', 'status', 'brand'];
const BRAND_KEYS = ['logo', 'outletPrefix', 'codePrefix', 'menuTitle', 'emoji', 'orderExample', 'menuExample', 'description', 'colors', 'region', 'upiExample'];

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newToken = () => crypto.randomBytes(24).toString('hex');

function cleanBrand(b = {}, name) {
  const out = {};
  for (const k of BRAND_KEYS) if (b[k] !== undefined && b[k] !== null && b[k] !== '') out[k] = b[k];
  if (out.colors) {
    out.colors = Object.fromEntries(Object.entries(out.colors).filter(([k, v]) => ['brand', 'brandDark', 'accent', 'menu'].includes(k) && /^#[0-9a-fA-F]{6}$/.test(v)));
  }
  // A darker shade for buttons and the header when only the main colour is given.
  if (out.colors?.brand && !out.colors.brandDark) {
    const n = parseInt(out.colors.brand.slice(1), 16);
    const dark = [16, 8, 0].map((sh) => Math.round(((n >> sh) & 255) * 0.78).toString(16).padStart(2, '0')).join('');
    out.colors.brandDark = `#${dark}`;
  }
  if (out.logo && !(Array.isArray(out.logo) && out.logo.length === 2 && out.logo.every((x) => typeof x === 'string'))) delete out.logo;
  if (out.codePrefix && !/^[A-Za-z]{1,3}$/.test(out.codePrefix)) throw new ValidationError('Order code prefix is 1 to 3 letters.', 'invalid');
  return { ...out, name };
}

function createRegistry({ db, defaultCommissionPct = 18 }) {
  const q = {
    all: db.prepare('SELECT * FROM restaurants ORDER BY name'),
    bySlug: db.prepare('SELECT * FROM restaurants WHERE slug = ?'),
    byId: db.prepare('SELECT * FROM restaurants WHERE id = ?'),
    byDomain: db.prepare('SELECT * FROM restaurants WHERE custom_domain = ?'),
    byWa: db.prepare('SELECT * FROM restaurants WHERE wa_phone_number_id = ?'),
  };

  /** Checked, normalised fields from a form. Unknown fields are ignored. */
  function fields(input, { partial }) {
    const out = {};
    const errors = [];
    for (const k of EDITABLE) {
      if (!(k in input)) continue;
      let v = input[k];
      if (k === 'brand') { out.brand = v; continue; }
      if (k === 'commission_pct') {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 50) errors.push('Commission is a % between 0 and 50.');
        else out.commission_pct = Math.round(n * 100) / 100;
        continue;
      }
      if (k === 'status') {
        if (!['active', 'paused'].includes(v)) errors.push('Status is active or paused.');
        else out.status = v;
        continue;
      }
      v = v == null ? '' : String(v).trim();
      if (UPPER.has(k)) v = v.toUpperCase();
      if (LOWER.has(k)) v = v.toLowerCase();
      if (k === 'contact_phone' || k === 'bank_account') v = v.replace(/[\s-]/g, '');
      if (v === '') { out[k] = null; continue; }
      if (v.length > 200) { errors.push(`${k} is too long.`); continue; }
      const check = CHECKS[k];
      if (check && !check[0].test(v)) { errors.push(check[1]); continue; }
      out[k] = v;
    }
    if (!partial && !out.name) errors.push('Enter the restaurant\'s name.');
    if ('name' in out && !out.name) errors.push('Name can\'t be empty.');
    if (errors.length) throw new ValidationError(errors.join(' '), 'invalid');
    return out;
  }

  function clash(f, selfId) {
    if (f.custom_domain) {
      const o = q.byDomain.get(f.custom_domain);
      if (o && o.id !== selfId) throw new ValidationError(`${f.custom_domain} is already used by ${o.name}.`, 'taken');
    }
    if (f.wa_phone_number_id) {
      const o = q.byWa.get(f.wa_phone_number_id);
      if (o && o.id !== selfId) throw new ValidationError(`That WhatsApp number is already used by ${o.name}.`, 'taken');
    }
  }

  /** New restaurant. Returns { restaurant, adminToken }: the token is shown once. */
  function create(input, now = new Date()) {
    const slug = String(input.slug || '').trim().toLowerCase();
    if (!SLUG.test(slug)) throw new ValidationError('Web address name: 1 to 30 lowercase letters, digits or dashes (e.g. spice-route).', 'invalid');
    if (RESERVED.has(slug)) throw new ValidationError(`"${slug}" is reserved. Pick another web address name.`, 'invalid');
    if (q.bySlug.get(slug)) throw new ValidationError(`${slug} is already taken.`, 'taken');
    const f = fields({ commission_pct: defaultCommissionPct, ...input }, { partial: false });
    clash(f);
    const brand = cleanBrand(f.brand || {}, f.name);
    const adminToken = newToken();
    const row = {
      ...Object.fromEntries(EDITABLE.filter((k) => k !== 'brand').map((k) => [k, f[k] ?? null])),
      slug, status: f.status || 'active', brand: JSON.stringify(brand), admin_token_hash: sha256(adminToken),
      created_at: now.toISOString(), updated_at: now.toISOString(),
    };
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO restaurants (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`).run(row);
    return { restaurant: q.bySlug.get(slug), adminToken };
  }

  function update(slug, input, now = new Date()) {
    const r = q.bySlug.get(slug);
    if (!r) return null;
    const f = fields(input, { partial: true });
    clash(f, r.id);
    if (f.brand) f.brand = JSON.stringify(cleanBrand({ ...JSON.parse(r.brand), ...f.brand }, f.name || r.name));
    else if (f.name) f.brand = JSON.stringify({ ...JSON.parse(r.brand), name: f.name });
    const cols = Object.keys(f);
    if (!cols.length) return r;
    db.prepare(`UPDATE restaurants SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @updated_at WHERE id = @id`)
      .run({ ...f, updated_at: now.toISOString(), id: r.id });
    return q.byId.get(r.id);
  }

  /** New head office token (the old one stops working). */
  function resetToken(slug) {
    const r = q.bySlug.get(slug);
    if (!r) return null;
    const adminToken = newToken();
    db.prepare('UPDATE restaurants SET admin_token_hash = ? WHERE id = ?').run(sha256(adminToken), r.id);
    return { restaurant: q.byId.get(r.id), adminToken };
  }

  const setRouteStatus = (id, status) => db.prepare('UPDATE restaurants SET route_status = ? WHERE id = ?').run(status, id);

  return {
    create, update, resetToken, setRouteStatus,
    list: () => q.all.all(),
    get: (slug) => q.bySlug.get(String(slug || '').toLowerCase()) || null,
    byId: (id) => q.byId.get(Number(id)) || null,
    byDomain: (host) => q.byDomain.get(String(host || '').toLowerCase()) || null,
    byWhatsApp: (id) => q.byWa.get(String(id || '')) || null,
    checkToken: (r, token) => Boolean(token) && sha256(token) === r.admin_token_hash,
  };
}

/** For the super-admin: no token hash, brand parsed. */
function present(r) {
  if (!r) return null;
  const { admin_token_hash: _drop, brand, ...rest } = r;
  return { ...rest, brand: JSON.parse(brand || '{}') };
}

/**
 * Menu pasted as CSV: Category, Name, Price (rupees), Veg (yes/no), Description.
 * A header row is skipped. Returns seed menu items.
 */
function parseMenuCsv(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { cells.push(cur); cur = ''; } else cur += c;
    }
    cells.push(cur);
    rows.push(cells.map((x) => x.trim()));
  }
  if (rows.length && /^category$/i.test(rows[0][0])) rows.shift();
  const errors = [];
  const menu = rows.map((r, i) => {
    const [category, name, price, veg = 'yes', description = ''] = r;
    const p = Number(String(price).replace(/[₹,\s]/g, ''));
    if (!category || !name) errors.push(`Line ${i + 1}: needs a category and a name.`);
    else if (!Number.isFinite(p) || p <= 0 || p > 100000) errors.push(`Line ${i + 1} (${name}): price should be in rupees, like 249.`);
    return { category, name, price: Math.round(p * 100) / 100, veg: !/^(n|no|non-?veg|false|0)$/i.test(veg), description };
  });
  if (errors.length) throw new ValidationError(errors.slice(0, 5).join(' '), 'invalid');
  return menu;
}

module.exports = { createRegistry, present, parseMenuCsv, sha256, SLUG };
