'use strict';

// Which restaurant the current code runs for, when one server hosts many
// (platform mode, src/platform/). Single-restaurant installs and the browser
// demo never set a provider, so everything falls back to the CLIENT profile
// and .env. The platform sets it to an AsyncLocalStorage lookup, so each
// request, timer and event runs with its own restaurant's brand and address.

let provider = () => null;

module.exports = {
  /** The current tenant: { brand, profile, baseUrl, ... } or null. */
  current: () => provider(),
  setProvider(fn) { provider = typeof fn === 'function' ? fn : () => null; },
};
