'use strict';

// Owner PIN for Head office → Connections. The head office login lets staff run
// the business (orders, menu, stock, outlets); changing payment gateways, UPI,
// WhatsApp or delivery partner keys also needs the owner's PIN.
//
// - The PIN (6–8 digits) is stored only as a scrypt hash.
// - It is set on the server (`npm run owner-pin`, or by setup.sh), never from
//   the panel by someone who doesn't know it; the owner can change it in the
//   panel by entering the current one.
// - Unlocking gives a token for this browser that expires after 10 minutes
//   without use. Locking, or closing the tab, ends it.
// - 5 wrong PINs lock the page for 15 minutes. Unlocks and failures are logged.

const crypto = require('node:crypto');
const { ValidationError } = require('./orders');

const KEY = 'owner.pinHash';
const MIN = 60000;
const MAX_FAILS = 5;
const LOCKOUT_MIN = 15;

class OwnerLockedError extends Error {}

function hash(pin, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(String(pin), salt, 32).toString('hex')}`;
}
// Constant-time string comparison (plain JS, so it also runs in the browser demo).
function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function matches(pin, stored) {
  const [salt, h] = String(stored).split(':');
  if (!salt || !h) return false;
  return sameString(crypto.scryptSync(String(pin), salt, 32).toString('hex'), h);
}

/** A PIN that isn't trivially guessable: 6–8 digits, not all the same, not a straight run. */
function checkPin(pin) {
  const p = String(pin || '');
  if (!/^\d{6,8}$/.test(p)) return 'The owner PIN must be 6 to 8 digits.';
  if (/^(\d)\1+$/.test(p)) return 'Choose a PIN that isn\'t one digit repeated.';
  const digits = [...p].map(Number);
  const run = (step) => digits.every((d, i) => i === 0 || d === (digits[i - 1] + step + 10) % 10);
  if (run(1) || run(-1)) return 'Choose a PIN that isn\'t a sequence like 123456.';
  return null;
}

function createOwnerLock({ store, idleMinutes = 10, clock = () => Date.now() }) {
  const sessions = new Map(); // token -> { exp (ms), pin: the PIN hash it was opened with }
  let fails = 0;
  let lockedUntil = 0;

  const stored = () => store.allSettings().find((r) => r.key === KEY)?.value || null;
  const log = (change) => store.addSettingsLog(new Date(clock()).toISOString(), 'head office', 'owner PIN', change);

  function setPin(pin, by = 'server') {
    const bad = checkPin(pin);
    if (bad) throw new ValidationError(bad, 'weak_pin');
    store.setSetting(KEY, hash(pin), false, new Date(clock()).toISOString(), by);
    sessions.clear(); // everyone unlocks again with the new PIN
    fails = 0; lockedUntil = 0;
    log(`PIN set (${by})`);
  }

  /** PIN -> { token, expiresAt }. Throws when wrong, not set, or locked out. */
  function unlock(pin) {
    const now = clock();
    if (!stored()) throw new OwnerLockedError('No owner PIN is set yet. Set it on the server: npm run owner-pin');
    if (now < lockedUntil) throw new OwnerLockedError(`Too many wrong PINs. Try again in ${Math.ceil((lockedUntil - now) / MIN)} min.`);
    if (!matches(pin, stored())) {
      fails += 1;
      log('wrong PIN entered');
      if (fails >= MAX_FAILS) { lockedUntil = now + LOCKOUT_MIN * MIN; fails = 0; log(`locked for ${LOCKOUT_MIN} min after ${MAX_FAILS} wrong PINs`); }
      throw new OwnerLockedError(`Wrong PIN.${now + 1 < lockedUntil ? ` Locked for ${LOCKOUT_MIN} min.` : ` ${MAX_FAILS - fails} tries left.`}`);
    }
    fails = 0;
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { exp: now + idleMinutes * MIN, pin: stored() });
    log('unlocked');
    return { token, expiresAt: new Date(now + idleMinutes * MIN).toISOString() };
  }

  /** Is this unlock token valid? Using it keeps it alive (idle timeout). */
  function check(token) {
    const now = clock();
    const s = token && sessions.get(token);
    if (!s) return false;
    // Expired, or the PIN was changed since (also from the server command).
    if (s.exp <= now || s.pin !== stored()) { sessions.delete(token); return false; }
    s.exp = now + idleMinutes * MIN;
    return true;
  }

  function lock(token) { sessions.delete(token); }

  /** Owner changes the PIN from the panel (must know the current one). */
  function changePin(current, next) {
    if (!stored() || !matches(current, stored())) throw new ValidationError('The current PIN is wrong.', 'wrong_pin');
    setPin(next, 'head office');
  }

  function status(token) {
    const now = clock();
    return { hasPin: Boolean(stored()), unlocked: token ? check(token) : false, lockedOutMinutes: now < lockedUntil ? Math.ceil((lockedUntil - now) / MIN) : 0, idleMinutes };
  }

  return { setPin, unlock, check, lock, changePin, status, hasPin: () => Boolean(stored()) };
}

module.exports = { createOwnerLock, checkPin, OwnerLockedError };
