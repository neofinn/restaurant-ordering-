'use strict';

// Heavy read-only reports (analytics, customer list) run in a worker thread
// with its own read-only database connection, so a report over a year of
// orders never pauses order taking, WhatsApp replies or the outlet tablets.
// Analytics results are cached briefly: several managers opening the dashboard
// at once cost one computation. In-memory databases (tests, demo) run inline.

const path = require('node:path');

const CACHE_MS = 15 * 1000;

function createReports({ dbPath, store, crm, computeAnalytics, inline = !dbPath || dbPath === ':memory:' }) {
  const cache = new Map();
  const cached = (key, compute) => {
    const hit = cache.get(key);
    if (hit && hit.at > Date.now() - CACHE_MS) return hit.value;
    const value = Promise.resolve().then(compute);
    cache.set(key, { at: Date.now(), value });
    value.catch(() => cache.delete(key));
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return value;
  };

  if (inline) {
    return {
      analytics: (q) => cached(`a:${JSON.stringify(q)}`, () => computeAnalytics(store, q)),
      customers: (q) => Promise.resolve().then(() => crm.list(q)),
      customersCsv: (q) => Promise.resolve(crm.exportCsv(q)),
      close() {},
    };
  }

  const { Worker } = require('node:worker_threads');
  let worker;
  let seq = 0;
  const pending = new Map();
  function start() {
    worker = new Worker(path.join(__dirname, 'reports-worker.js'), { workerData: { dbPath } });
    worker.unref();
    worker.on('message', ({ id, value, error }) => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (error) p.reject(new Error(error)); else p.resolve(value);
    });
    worker.on('error', (e) => { for (const p of pending.values()) p.reject(e); pending.clear(); worker = null; });
    worker.on('exit', () => { worker = null; });
  }
  const ask = (kind, args) => new Promise((resolve, reject) => {
    if (!worker) start();
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, kind, args });
  });

  return {
    analytics: (q) => cached(`a:${JSON.stringify(q)}`, () => ask('analytics', q)),
    // Not cached: staff expect their own edits (points, tags) to show at once.
    customers: (q) => ask('customers', q),
    customersCsv: (q) => ask('customersCsv', q),
    close() { if (worker) worker.terminate(); },
  };
}

module.exports = { createReports };
