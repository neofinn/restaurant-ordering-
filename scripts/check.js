'use strict';

// Go-live check without starting the server: npm run check
// Exit code 1 if anything would stop the server starting in production.

const config = require('../src/config');
const { openDb } = require('../src/db');
const { createSqliteStore } = require('../src/store/sqlite');
const { preflight, format } = require('../src/preflight');
const { brand } = require('../src/brand');

const db = openDb(config.dbPath);
const report = preflight(config, createSqliteStore(db));
db.close();
console.log(`${brand().name}: setup check (${config.production ? 'production' : 'not production'}, database ${config.dbPath})\n`);
console.log(format(report));
console.log(`\n${report.errors.length} to fix, ${report.warnings.length} to review.`);
process.exit(report.errors.length ? 1 : 0);
