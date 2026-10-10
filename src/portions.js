'use strict';

// Dishes sold in two portions are stored as two menu items, "<dish> (Half)" and
// "<dish> (Full)". These helpers put them back together for display.

const PORTION = /\s*\((Half|Full)\)$/;

/** "Veg Steam Momo (Half)" -> { dish: 'Veg Steam Momo', portion: 'Half' } */
function portionOf(name) {
  const m = String(name).match(PORTION);
  return { dish: String(name).replace(PORTION, ''), portion: m ? m[1] : null };
}

/** Menu items -> dishes in menu order: [{ dish, veg, items: [Half, Full] or [item] }] */
function groupDishes(items) {
  const byDish = new Map();
  for (const i of items) {
    const { dish } = portionOf(i.name);
    if (!byDish.has(dish)) byDish.set(dish, { dish, veg: i.veg, items: [] });
    byDish.get(dish).items.push(i);
  }
  const order = { Half: 0, Full: 1 };
  for (const d of byDish.values()) d.items.sort((a, b) => (order[portionOf(a.name).portion] ?? 2) - (order[portionOf(b.name).portion] ?? 2));
  return [...byDish.values()];
}

module.exports = { portionOf, groupDishes, PORTION };
