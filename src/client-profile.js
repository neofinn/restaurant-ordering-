'use strict';

// Loads a client profile folder (the browser demo build swaps this file for a
// fixed one, as bundles can't load folders by name).

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CLIENT = 'sample';

const dirFor = (id) => (/[\\/]/.test(id || '') ? path.resolve(id) : path.join(__dirname, '..', 'clients', id || DEFAULT_CLIENT));

module.exports = function loadProfile(id) {
  const dir = dirFor(id);
  if (!fs.existsSync(dir)) throw new Error(`Client profile not found: ${dir} (set CLIENT to a folder in clients/)`);
  return require(dir);
};
module.exports.dirFor = dirFor;
