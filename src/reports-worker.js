'use strict';

// Worker thread for src/reports.js: read-only connection, same report code.

const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { createSqliteStore } = require('./store/sqlite');
const { createCrm } = require('./crm');
const { computeAnalytics } = require('./analytics');

const db = new DatabaseSync(workerData.dbPath, { readOnly: true });
db.exec('PRAGMA busy_timeout = 5000');
const store = createSqliteStore(db);
// The CRM's order listeners are not needed here; only its read side is used.
const crm = createCrm({ store, orders: { events: { on() {} } } });

const jobs = {
  analytics: (q) => computeAnalytics(store, q),
  customers: (q) => crm.list(q),
  customersCsv: (q) => crm.exportCsv(q),
};

parentPort.on('message', ({ id, kind, args }) => {
  try {
    parentPort.postMessage({ id, value: jobs[kind](args || {}) });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
