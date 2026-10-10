'use strict';

// Stock at each outlet, controlled by head office (admin panel). Per outlet and
// dish: switched on/off, and optionally a count of how many are left. Orders
// take from the count and a cancellation puts it back (src/orders.js); at 0 the
// dish shows as sold out at that outlet on web and WhatsApp. Outlet tablets can
// only see it.

const { ValidationError } = require('./orders');

const MAX_COUNT = 9999;

function createStockService({ store, orders }) {
  /** Every dish × every outlet, for the admin stock screen. */
  function board() {
    const outlets = orders.listOutlets().map((o) => ({ id: o.id, name: o.name, accepting: !!o.accepting_orders }));
    const off = new Set(store.allUnavailable().map((r) => `${r.outlet_id}|${r.item_id}`));
    const counts = new Map(store.allStock().map((r) => [`${r.outlet_id}|${r.item_id}`, r]));
    const items = store.menuItems().map((i) => ({
      id: i.id, name: i.name, category: i.category, veg: !!i.veg,
      outlets: Object.fromEntries(outlets.map((o) => {
        const k = `${o.id}|${i.id}`;
        const c = counts.get(k);
        const on = !off.has(k);
        const remaining = c ? c.remaining : null;
        return [o.id, { on, remaining, available: on && (remaining ?? 1) > 0, updatedAt: c?.updated_at || null }];
      })),
    }));
    return { outlets, items };
  }

  /**
   * Change one dish at one outlet, or at every outlet (outletId 'all').
   * available: switch on/off. remaining: a count, or null for no limit.
   */
  function set({ outletId, itemId, available, remaining }, now = new Date()) {
    const id = Number(itemId);
    if (!store.menuItems().some((i) => i.id === id)) throw new ValidationError('Unknown dish.');
    const targets = outletId === 'all' ? orders.listOutlets().map((o) => o.id) : [Number(outletId)];
    if (!targets.every((o) => orders.getOutlet(o))) throw new ValidationError('Unknown outlet.');
    let count;
    if (remaining !== undefined) {
      count = remaining === null || remaining === '' ? null : Number(remaining);
      if (count !== null && (!Number.isInteger(count) || count < 0 || count > MAX_COUNT)) {
        throw new ValidationError(`Stock count must be a whole number from 0 to ${MAX_COUNT}, or empty for no limit.`);
      }
    }
    for (const o of targets) {
      if (typeof available === 'boolean') store.setAvailability(o, id, available);
      if (remaining !== undefined) store.setStock(o, id, count, now.toISOString());
    }
    return board();
  }

  return { board, set };
}

module.exports = { createStockService };
