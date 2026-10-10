'use strict';

// Menu management for the admin panel: edit or add dishes, and change prices
// in one click (whole menu, a category or picked dishes; by % or by ₹, rounded
// to a nice number). Every bulk change can be previewed first and undone.

const { ValidationError } = require('./orders');

// Groups the rows of one price change so it can be undone together.
let seq = 0;
const batchId = () => `${Date.now().toString(36)}-${(seq += 1).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

class MenuError extends ValidationError {}

function createMenuAdmin({ store }) {
  const present = (i) => ({ ...i, veg: !!i.veg, active: !!i.active });

  function list() {
    return store.allMenuItems().map(present);
  }

  function clean(fields) {
    const out = {};
    if (fields.name !== undefined) {
      out.name = String(fields.name).trim().slice(0, 80);
      if (!out.name) throw new MenuError('Dish name is required.');
    }
    if (fields.category !== undefined) {
      out.category = String(fields.category).trim().slice(0, 40);
      if (!out.category) throw new MenuError('Category is required.');
    }
    if (fields.description !== undefined) out.description = String(fields.description).trim().slice(0, 200);
    if (fields.price !== undefined) {
      const rupees = Number(fields.price);
      if (!Number.isFinite(rupees) || rupees <= 0 || rupees > 10000) throw new MenuError('Price must be between ₹1 and ₹10,000.');
      out.price = Math.round(rupees * 100);
    }
    if (fields.veg !== undefined) out.veg = fields.veg ? 1 : 0;
    if (fields.active !== undefined) out.active = fields.active ? 1 : 0;
    return out;
  }

  function update(id, fields) {
    const item = store.allMenuItems().find((i) => i.id === Number(id));
    if (!item) return null;
    const f = clean(fields);
    if (f.price !== undefined && f.price !== item.price) {
      store.setPrices([{ id: item.id, oldPrice: item.price, newPrice: f.price }], batchId(), `Edited ${item.name}`, new Date().toISOString());
      delete f.price;
    }
    store.updateMenuItem(item.id, f);
    return present(store.allMenuItems().find((i) => i.id === item.id));
  }

  function add(fields) {
    const f = clean({ active: true, veg: true, description: '', ...fields });
    if (!f.name || !f.category || !f.price) throw new MenuError('Name, category and price are required.');
    const id = store.insertMenuItem(f);
    return present(store.allMenuItems().find((i) => i.id === id));
  }

  /**
   * Bulk price change. scope: 'all' | 'category' | 'items'; mode: 'percent' |
   * 'amount' (₹, can be negative); round: nearest ₹1 / ₹5 / ₹10.
   * apply=false returns the preview only.
   */
  function bulkPrice({ scope = 'all', category, itemIds = [], mode = 'percent', value, round = 1, apply = false }) {
    const v = Number(value);
    if (!Number.isFinite(v) || v === 0) throw new MenuError('Enter how much to change prices by.');
    if (mode === 'percent' && (v <= -90 || v > 200)) throw new MenuError('Percent change must be between -90% and +200%.');
    const step = [1, 5, 10].includes(Number(round)) ? Number(round) : 1;
    const ids = new Set(itemIds.map(Number));
    const targets = store.allMenuItems().filter((i) => (scope === 'all' && i.active)
      || (scope === 'category' && i.category === category)
      || (scope === 'items' && ids.has(i.id)));
    if (!targets.length) throw new MenuError('No dishes match that selection.');
    const changes = targets.map((i) => {
      const rupees = mode === 'percent' ? (i.price / 100) * (1 + v / 100) : i.price / 100 + v;
      const rounded = Math.max(step, Math.round(rupees / step) * step);
      return { id: i.id, name: i.name, category: i.category, oldPrice: i.price, newPrice: Math.round(rounded * 100) };
    }).filter((c) => c.newPrice !== c.oldPrice);
    const label = `${mode === 'percent' ? `${v > 0 ? '+' : ''}${v}%` : `${v > 0 ? '+' : '-'}₹${Math.abs(v)}`} on ${scope === 'all' ? 'all dishes' : scope === 'category' ? category : `${targets.length} dishes`}`;
    if (apply && changes.length) store.setPrices(changes, batchId(), label, new Date().toISOString());
    return { applied: !!apply && changes.length > 0, label, changes };
  }

  /** Undo the most recent price change (bulk or single). */
  function undo() {
    const batch = store.lastPriceBatch();
    if (!batch.length) throw new MenuError('There is no price change to undo.');
    store.setPrices(batch.map((h) => ({ id: h.item_id, oldPrice: h.new_price, newPrice: h.old_price })), null);
    store.dropPriceBatch(batch[0].batch);
    return { undone: batch[0].note, count: batch.length };
  }

  const lastChange = () => {
    const b = store.lastPriceBatch();
    return b.length ? { note: b[0].note, at: b[0].at, count: b.length } : null;
  };

  return { list, update, add, bulkPrice, undo, lastChange, MenuError };
}

module.exports = { createMenuAdmin, MenuError };
