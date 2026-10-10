'use strict';

// Menu as images for WhatsApp. A chat can't hold a 138-dish menu as lists, so
// the bot sends the menu as a few pictures (always from the live menu, so
// prices and dishes match the admin panel) and the customer types the order.
//
// Each page is an SVG (1080 px wide, sized to fit WhatsApp's image limits).
// The server turns it into a PNG with resvg and serves it at /menu/page-<n>.png;
// the browser demo shows the SVG itself.

const crypto = require('node:crypto');
const path = require('node:path');
const { groupDishes, portionOf } = require('../portions');
const { brand } = require('../brand');

const W = 1080;
const ROW = 46;
const CAT = 78;
const HEAD = 210;
const FOOT = 120;
const MAX_ROWS = 36; // dish rows per page at most; keeps text readable after WhatsApp compression

const COLORS = { bg: '#FBF7F2', ink: '#221C19', muted: '#6E625A', red: '#C62A1F', line: '#E6DCD1', veg: '#1A8A3A', nonveg: '#B3261E', band: '#221C19' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const price = (p) => `₹${Math.round(p / 100)}`;

/** Split the menu into pages of whole categories (a long category is split across pages). */
function paginate(items) {
  const cats = [];
  for (const i of items) {
    let c = cats.find((x) => x.name === i.category);
    if (!c) cats.push(c = { name: i.category, items: [] });
    c.items.push(i);
  }
  // Spread dishes evenly: 138 dishes -> 4 pages of ~35, not 3 full ones and a stub.
  const totalDishes = cats.reduce((t, c) => t + groupDishes(c.items).length, 0);
  const perPage = Math.ceil(totalDishes / Math.max(1, Math.ceil(totalDishes / MAX_ROWS)));
  const pages = [];
  let page = { sections: [], rows: 0 };
  for (const c of cats) {
    let dishes = groupDishes(c.items);
    while (dishes.length) {
      const room = (pages.length === Math.ceil(totalDishes / perPage) - 1 ? MAX_ROWS + 6 : perPage) - page.rows;
      // Start a new page rather than leave a heading with fewer than 4 dishes under it.
      if (room < Math.min(4, dishes.length)) { pages.push(page); page = { sections: [], rows: 0 }; continue; }
      const take = dishes.slice(0, room);
      page.sections.push({ name: c.name, cont: dishes.length !== groupDishes(c.items).length, dishes: take });
      page.rows += take.length;
      dishes = dishes.slice(take.length);
    }
  }
  if (page.sections.length) pages.push(page);
  return pages;
}

function pageSvg(page, n, total) {
  const b = brand();
  const C = { ...COLORS, red: b.colors.menu };
  const height = HEAD + page.sections.reduce((h, s) => h + CAT + s.dishes.length * ROW, 0) + FOOT;
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" font-family="Inter, Arial, sans-serif">`);
  out.push(`<rect width="${W}" height="${height}" fill="${C.bg}"/>`);
  out.push(`<rect width="${W}" height="150" fill="${C.red}"/>`);
  out.push(`<text x="48" y="78" font-size="44" font-weight="700" fill="#FFF6EE">${esc(b.menuTitle)}</text>`);
  out.push(`<text x="48" y="122" font-size="26" fill="#FFE7DA">Menu ${n} of ${total} · prices in ₹ · +5% GST</text>`);
  out.push(`<text x="${W - 48}" y="78" font-size="26" font-weight="700" fill="#FFF6EE" text-anchor="end">Order here in chat</text>`);
  out.push(`<text x="${W - 48}" y="122" font-size="24" fill="#FFE7DA" text-anchor="end">just type what you want</text>`);
  let y = HEAD - 20;
  for (const s of page.sections) {
    y += CAT;
    out.push(`<text x="48" y="${y - 22}" font-size="34" font-weight="700" fill="${C.red}">${esc(s.name.toUpperCase())}${s.cont ? ' (contd.)' : ''}</text>`);
    out.push(`<text x="${W - 230}" y="${y - 22}" font-size="22" font-weight="700" fill="${C.muted}" text-anchor="end">HALF</text>`);
    out.push(`<text x="${W - 48}" y="${y - 22}" font-size="22" font-weight="700" fill="${C.muted}" text-anchor="end">FULL</text>`);
    out.push(`<rect x="48" y="${y - 8}" width="${W - 96}" height="2" fill="${C.line}"/>`);
    for (const d of s.dishes) {
      y += ROW;
      const half = d.items.find((i) => portionOf(i.name).portion === 'Half');
      const full = d.items.find((i) => portionOf(i.name).portion !== 'Half');
      const col = d.veg ? C.veg : C.nonveg;
      out.push(`<rect x="50" y="${y - 27}" width="20" height="20" rx="3" fill="none" stroke="${col}" stroke-width="2.5"/><circle cx="60" cy="${y - 17}" r="5" fill="${col}"/>`);
      out.push(`<text x="86" y="${y - 10}" font-size="28" fill="${C.ink}">${esc(d.dish)}</text>`);
      out.push(`<text x="${W - 230}" y="${y - 10}" font-size="28" fill="${C.ink}" text-anchor="end">${half ? price(half.price) : '–'}</text>`);
      out.push(`<text x="${W - 48}" y="${y - 10}" font-size="28" font-weight="700" fill="${C.ink}" text-anchor="end">${full ? price(full.price) : '–'}</text>`);
    }
    y += 10;
  }
  out.push(`<rect y="${height - FOOT + 20}" width="${W}" height="${FOOT - 20}" fill="${C.band}"/>`);
  const example = b.menuExample || b.orderExample;
  out.push(`<text x="48" y="${height - 52}" font-size="26" fill="#FBF7F2">${example ? `Type e.g. <tspan font-weight="700">${esc(example)}</tspan>` : 'Type your order in the chat, the way you would say it'}</text>`);
  out.push('</svg>');
  return out.join('');
}

/**
 * Menu pages for WhatsApp. menuItems() returns the current menu items.
 * baseUrl: where the server serves /menu/page-<n>.png (null in the demo).
 */
function createMenuImages({ menuItems, baseUrl = null, fontsDir = null }) {
  let cached = { key: null, pages: [], png: new Map() };
  let Resvg;

  function current() {
    const items = menuItems().filter((i) => i.active !== 0 && i.active !== false);
    const key = crypto.createHash('sha256').update(JSON.stringify(items.map((i) => [i.id, i.name, i.price, i.category, i.veg]))).digest('hex').slice(0, 12);
    if (cached.key !== key) {
      const pages = paginate(items);
      cached = {
        key,
        png: new Map(),
        pages: pages.map((p, i) => ({
          n: i + 1,
          svg: pageSvg(p, i + 1, pages.length),
          caption: `Menu ${i + 1}/${pages.length}: ${[...new Set(p.sections.map((s) => s.name))].join(', ')}`,
        })),
      };
    }
    return cached;
  }

  /** WhatsApp image replies for every page. */
  function messages() {
    const c = current();
    return c.pages.map((p) => ({
      type: 'image', url: baseUrl ? `${baseUrl}/menu/page-${p.n}.png?v=${c.key}` : null, svg: p.svg, text: p.caption,
    }));
  }

  /** PNG bytes for page n (server only; needs @resvg/resvg-js). */
  function png(n) {
    const c = current();
    const page = c.pages.find((p) => p.n === Number(n));
    if (!page) return null;
    if (!c.png.has(page.n)) {
      Resvg ||= require('@resvg/resvg-js').Resvg;
      // Bundled fonts, so the pictures look the same on any server.
      fontsDir ||= path.join(__dirname, '..', '..', 'assets', 'fonts');
      const r = new Resvg(page.svg, {
        fitTo: { mode: 'width', value: W },
        font: { fontFiles: [path.join(fontsDir, 'Inter-Regular.otf'), path.join(fontsDir, 'Inter-Bold.otf')], loadSystemFonts: false, defaultFontFamily: 'Inter' },
      });
      c.png.set(page.n, r.render().asPng());
    }
    return c.png.get(page.n);
  }

  /** Images can be sent when PNGs can be made (server) or shown inline (demo). */
  function available() {
    if (!baseUrl) return true;
    try { require.resolve('@resvg/resvg-js'); return true; } catch { return false; }
  }

  return { messages, png, available, pages: () => current().pages };
}

module.exports = { createMenuImages, paginate, pageSvg };
