'use strict';

// Minimal browser stand-ins for the Node built-ins the shared code uses.

class EventEmitter {
  constructor() { this.handlers = new Map(); }
  on(name, fn) { (this.handlers.get(name) || this.handlers.set(name, []).get(name)).push(fn); return this; }
  emit(name, ...args) { for (const fn of this.handlers.get(name) || []) fn(...args); return true; }
  off(name, fn) { const l = this.handlers.get(name); if (l && l.includes(fn)) l.splice(l.indexOf(fn), 1); return this; }
  listenerCount(name) { return (this.handlers.get(name) || []).length; }
}

function randomBytes(n) {
  const a = new Uint8Array(n);
  globalThis.crypto.getRandomValues(a);
  return a;
}

// Demo only: a fast non-cryptographic stand-in for scrypt/sha256 so outlet PIN
// logins work in the browser. The real server uses Node's crypto.
function fnvBytes(text, n) {
  const out = new Uint8Array(n);
  let h = 0x811c9dc5;
  for (let i = 0; i < n; i++) {
    for (const c of text + i) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    out[i] = h & 0xff;
  }
  return out;
}
const scryptSync = (pin, salt, n) => fnvBytes(`${salt}:${pin}`, n);
function createHash() {
  let data = '';
  return { update(x) { data += x; return this; }, digest: () => fnvBytes(data, 32) };
}

const join = (...parts) => parts.join('/');

module.exports = { EventEmitter, randomBytes, scryptSync, createHash, join };
