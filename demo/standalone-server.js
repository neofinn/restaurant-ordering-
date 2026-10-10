'use strict';

// Standalone demo pages (GitHub Pages): runs the in-browser backend and keeps
// it in IndexedDB, so the demo survives page changes, reloads and closed tabs.
// Loaded in the SharedWorker (demo-worker.js) or, without SharedWorker support,
// in the page itself. Needs RCBackend (demo-backend.js) loaded first.

/* global RCBackend */
self.RCDemoServer = (() => {
  const DB = `${RCBackend.brandId}-demo`;
  const KEY = 'state';

  const open = () => new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const op = (mode, fn) => open().then((db) => new Promise((resolve) => {
    const req = fn(db.transaction('kv', mode).objectStore('kv'));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  })).catch(() => null);
  const load = () => op('readonly', (s) => s.get(KEY));
  const save = (text) => op('readwrite', (s) => s.put(text, KEY));
  const clear = () => op('readwrite', (s) => s.delete(KEY));

  function fresh() { return RCBackend.createDemoBackend(); }

  let be;
  let timer;
  // Save shortly after anything changes (requests, rider updates, reviews).
  function persistSoon() {
    clearTimeout(timer);
    timer = setTimeout(() => { try { save(JSON.stringify(be.snapshot())); } catch (e) { /* storage full or blocked */ } }, 400);
  }
  function watch() {
    be.orders.events.on('created', persistSoon);
    be.orders.events.on('status', persistSoon);
    be.orders.events.on('payment', persistSoon);
    be.dispatcher.events.on('delivery', persistSoon);
    be.handoffs.events.on('message', persistSoon);
  }

  const ready = load().then((text) => {
    try { be = text ? RCBackend.createDemoBackend({ state: JSON.parse(text) }) : fresh(); } catch (e) { be = fresh(); }
    watch();
    if (!text) persistSoon();
  });

  /** msg: { method, url, body, token } or { kind: 'reset' }. Resolves to { status, body }. */
  async function handle(msg) {
    await ready;
    if (msg.kind === 'reset') {
      await clear();
      be = fresh();
      watch();
      persistSoon();
      return { status: 200, body: { ok: true } };
    }
    const res = await be.request(msg.method, msg.url, msg.body, msg.token, msg.ownerToken);
    // Save before answering: the page may navigate away (e.g. to tracking) right after.
    if (msg.method !== 'GET') { clearTimeout(timer); try { await save(JSON.stringify(be.snapshot())); } catch (e) { /* storage full or blocked */ } }
    const body = typeof res.body === 'string' ? res.body : JSON.parse(JSON.stringify(res.body ?? null));
    return { status: res.status, body };
  }

  return { handle };
})();
