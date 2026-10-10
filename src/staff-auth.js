'use strict';

// Who is calling the staff APIs:
//  - head office (admin panel, /admin/): the ADMIN_TOKEN; sees and controls everything.
//  - an outlet (outlet panel, /outlet/): logs in with that outlet's PIN, which
//    head office sets. The session only ever reaches that outlet's orders and chats.

const crypto = require('node:crypto');

const SESSION_DAYS = 30;
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function sameText(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

function hashPin(pin, salt = hex(crypto.randomBytes(16))) {
  return `scrypt$${salt}$${hex(crypto.scryptSync(String(pin), salt, 32))}`;
}

function checkPin(pin, stored) {
  const [, salt] = String(stored || '').split('$');
  return !!salt && sameText(hashPin(pin, salt), stored);
}

const tokenHash = (token) => hex(crypto.createHash('sha256').update(String(token)).digest());

class AuthError extends Error {
  constructor(message, status = 401) { super(message); this.status = status; }
}

function createStaffAuth({ store, adminToken }) {
  const fails = new Map(); // outletId -> { n, until }

  /** Head office sets or changes an outlet's PIN. Signs that outlet's tablets out. */
  function setPin(outletId, pin, now = new Date()) {
    const p = String(pin || '').trim();
    if (!/^\d{4,8}$/.test(p)) throw new AuthError('PIN must be 4 to 8 digits.', 400);
    store.setOutletPin(outletId, hashPin(p), now.toISOString());
    store.dropStaffSessions(outletId);
    fails.delete(Number(outletId));
  }

  /** Outlet tablet login. Returns a session token. */
  function login(outletId, pin, now = new Date()) {
    const id = Number(outletId);
    const f = fails.get(id) || { n: 0, until: 0 };
    if (f.until > now.getTime()) throw new AuthError('Too many wrong PINs. Try again in 5 minutes.', 429);
    const row = store.outletPinHash(id);
    if (!row) throw new AuthError('This outlet has no PIN yet. Ask head office to set one.');
    if (!checkPin(pin, row.pin_hash)) {
      // After a lockout has passed, counting starts again.
      const n = f.until ? 1 : f.n + 1;
      fails.set(id, { n, until: n >= MAX_FAILS ? now.getTime() + LOCK_MS : 0 });
      throw new AuthError('Wrong PIN.');
    }
    fails.delete(id);
    const token = hex(crypto.randomBytes(24));
    const expires = new Date(now.getTime() + SESSION_DAYS * 86400000);
    store.addStaffSession(tokenHash(token), id, now.toISOString(), expires.toISOString());
    return { token, outletId: id, expiresAt: expires.toISOString() };
  }

  function logout(token) { store.dropStaffSession(tokenHash(token)); }

  /** Sign every tablet of an outlet out (e.g. a lost phone). */
  function signOutOutlet(outletId) { store.dropStaffSessions(outletId); }

  /** Bearer token -> { role: 'admin' } | { role: 'outlet', outletId } | null */
  function resolve(token, now = new Date()) {
    if (!token) return null;
    if (adminToken && sameText(token, adminToken)) return { role: 'admin' };
    const s = store.staffSession(tokenHash(token), now.toISOString());
    return s ? { role: 'outlet', outletId: s.outlet_id } : null;
  }

  /** For the admin panel: which outlets have a PIN and how many tablets are signed in. */
  function loginStatus(now = new Date()) {
    const pins = new Map(store.outletLogins().map((r) => [r.outlet_id, r.updated_at]));
    const sessions = new Map(store.staffSessionCounts(now.toISOString()).map((r) => [r.outlet_id, r]));
    return store.outlets().map((o) => ({
      outletId: o.id, hasPin: pins.has(o.id), pinSetAt: pins.get(o.id) || null,
      devices: sessions.get(o.id)?.n || 0, lastLoginAt: sessions.get(o.id)?.last || null,
    }));
  }

  return { setPin, login, logout, signOutOutlet, resolve, loginStatus };
}

module.exports = { createStaffAuth, AuthError, hashPin, checkPin };
