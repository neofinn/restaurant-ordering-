'use strict';

// WhatsApp ordering conversation.
//
// The bot is transport-agnostic: it takes a normalised incoming message and
// returns a list of abstract replies ({type: 'text' | 'buttons' | 'list' |
// 'location_request'}). src/whatsapp/client.js turns those into WhatsApp Cloud
// API payloads; the dev simulator and the browser demo render them directly.
//
// Customers can order three ways, and mix them freely:
//   1. Tapping through menu lists and buttons.
//   2. Typing like they'd text a person: "2 half kurkure veg momo less spicy,
//      ek full veg hakka noodles no onion" (see nlu.js). Special instructions
//      stay attached to each item; ambiguous items ("chilli chicken") get a
//      follow-up question, and so does Half or Full when it isn't said.
//   3. Sending a cart from the WhatsApp Business catalog.
// Whatever the route, the outlet is chosen from the customer's location.
// Anything the bot can't handle goes to a person at the outlet (handoff).

const config = require('../config');
const { assignOutlet, isOpen, etaMinutes } = require('../geo');
const { rupees } = require('../format');
const { ValidationError, deliveryFee, deliveryCharge, canPayOnline } = require('../orders');
const { parseOrderText } = require('./nlu');
const { placeAddress } = require('../geocode');
const { roadKm } = require('../geo');
const { qrSvg, orderDetailsReply } = require('../payments');
const { orderConfirmedText } = require('./notify');

const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_QTY = 20;

// WhatsApp interactive message limits.
const { portionOf, groupDishes } = require('../portions');
const { brand, shortName: outletShort } = require('../brand');

const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1) + '…');
const btn = (id, title) => ({ id, title: clip(title, 20) });
const row = (id, title, description) => ({ id, title: clip(title, 24), ...(description ? { description: clip(description, 72) } : {}) });

const text = (t) => ({ type: 'text', text: t });
const buttons = (t, list) => ({ type: 'buttons', text: t, buttons: list.slice(0, 3) });
const list = (t, button, sections) => ({ type: 'list', text: t, button: clip(button, 20), sections });
// Button messages allow 1024 characters; send long summaries (big carts) as a text first.
const longButtons = (t, list) => (t.length <= 1024 ? [buttons(t, list)] : [text(t), buttons('What would you like to do?', list)]);

const HUMAN_RE = /\b(human|agent|real person|a person|staff|manager|talk to (?:someone|somebody|you|a person|team|staff)|call me|baat karni|baat karo|customer care|complaint|special request|bulk order|party order|catering)\b/;
const BACK_TO_BOT = ['bot', 'menu', 'exit', 'order', 'back'];
const CATALOG_PREFIX = 'RC-';

const describe = (name, note) => `${name}${note ? ` _(${note})_` : ''}`;

function freshSession() {
  return {
    state: 'start', fulfilment: null, lat: null, lng: null, outletId: null, distanceKm: null,
    cart: [], pendingItemId: null, address: null, choices: [], orderNotes: [], checkingOut: false, areaChoices: [],
  };
}

function createBot({ orders, sessions, handoffs = null, crm = null, reviews = null, places = () => [], baseUrl = config.publicBaseUrl, menuImages = null }) {
  function load(phone, now) {
    const s = sessions.get(phone);
    if (!s || now - new Date(s.updatedAt).getTime() > SESSION_TTL_MS) return freshSession();
    return { ...freshSession(), ...s.data };
  }

  const outletOf = (s) => (s.outletId ? orders.getOutlet(s.outletId) : null);
  const menuMap = (s) => new Map(orders.menuFor(s.outletId).map((i) => [i.id, i]));

  function addLine(s, id, qty, note = '') {
    const line = s.cart.find((l) => l.id === id && (l.note || '') === (note || ''));
    if (line) line.qty = Math.min(line.qty + qty, MAX_QTY);
    else s.cart.push({ id, qty: Math.min(qty, MAX_QTY), ...(note ? { note } : {}) });
  }

  // ---- Screens -----------------------------------------------------------

  function welcome(name) {
    return [
      buttons(`Namaste${name ? ' ' + name : ''}! 🙏 Welcome to *${brand().name}* ${brand().emoji}\n\n`
        + '*Delivery or pickup?*\n\n'
        + 'Once we know where you are, you can tap through the menu or just type your order'
        + (brand().orderExample ? `, like:\n_"${brand().orderExample}"_\n\n` : '.\n\n')
        + 'Type *track* for your order status.', [
        btn('mode:delivery', '🛵 Delivery'),
        btn('mode:pickup', '🏃 Pickup'),
        btn('act:human', '💬 Talk to us'),
      ]),
    ];
  }

  const shortName = (o) => outletShort(o.name);

  // Delivery: current location, typed full address, or both.
  function askLocation(prefix = '') {
    return [{
      type: 'location_request',
      text: `${prefix}📍 *Where should we deliver?*\n\nTap *Send location* to share your current location, or type your full address (house/flat no., street, area, city).\nSending both gets the rider to your exact door.`,
    }];
  }

  function askDelivery(s, prefix = '') {
    s.fulfilment = 'delivery';
    s.state = 'await_location';
    return askLocation(prefix);
  }

  // Outlets for pickup, nearest first once we know where the customer is.
  function pickupOutlets(now, from = null) {
    const rows = orders.listOutlets()
      .map((o) => ({ o, km: from ? roadKm(from, o) : null }))
      .sort((a, b) => (a.km ?? 0) - (b.km ?? 0))
      .map(({ o, km }) => row(`outlet:${o.id}`, shortName(o),
        `${km != null ? `${km} km · ` : ''}${isOpen(o, now) ? 'Open' : 'Closed'} · ${o.opens === o.closes ? '24 hours' : `${o.opens}-${o.closes}`} · ${o.address}`));
    return [list(`🏃 *Pickup:* choose the outlet you'll collect from.${from ? ' Nearest first.' : ''}`, 'Choose outlet', [{ title: 'Outlets', rows: rows.slice(0, 10) }])];
  }

  function pickupStart(s, now) {
    s.fulfilment = 'pickup';
    s.outletId = null;
    s.distanceKm = null;
    s.state = 'choose_outlet';
    if (s.lat != null) return pickupSuggest(s, now);
    return [
      ...pickupOutlets(now),
      { type: 'location_request', text: '📍 Not sure which is closest? Share your location and I\'ll suggest the nearest outlet.' },
    ];
  }

  // Suggest the nearest open outlets for pickup.
  function pickupSuggest(s, now) {
    const a = assignOutlet(orders.listOutlets(), s, { fulfilment: 'pickup', now });
    const open = a.ranked.filter((r) => r.open).slice(0, 2);
    if (!open.length) return [text('😔 All our outlets are closed right now. Please try again during opening hours.')];
    const [first] = open;
    return [buttons(`📍 Your nearest outlet is *${first.outlet.name}*, ${first.distanceKm} km away (${first.outlet.address}). Ready in about ${etaMinutes('pickup')} min after you order.\n\nPick up from here?`, [
      // Buttons allow 20 characters: "Sector 11 · 1.5 km".
      ...open.map((r) => btn(`outlet:${r.outlet.id}`, `${shortName(r.outlet).replace(` ${r.outlet.city}`, '')} · ${r.distanceKm} km`)),
      btn('act:outlets', 'All outlets'),
    ])];
  }

  // Outlet is set and checks passed: show the menu (or carry on with a cart/checkout).
  function readyMenu(s, intro) {
    s.state = 'browsing';
    if (s.cart.length) return afterOutletKnown(s, intro);
    return menuView(s, intro);
  }

  // The menu as pictures, then "just type your order". The full menu doesn't
  // fit WhatsApp lists (10 rows each), so typing is the main way to order;
  // the lists stay available under "Browse menu".
  function menuView(s, intro) {
    if (!menuImages || !menuImages.available()) return categoriesList(s, intro);
    return [
      ...(intro ? [text(intro)] : []),
      ...menuImages.messages(),
      buttons('😋 *Just type your order*, the way you would message us. For example:\n'
        + '_2 half veg steam momo, 1 full chilli potato less spicy, 1 veg manchow soup_\n\n'
        + "Say *half* or *full* (or I'll ask). I'll arrange it into a proper order with prices before you confirm.", [
        btn('act:browse', '📋 Browse menu'),
        btn('act:human', '💬 Talk to us'),
      ]),
    ];
  }

  // A WhatsApp list holds 10 rows: show 9 and a "More" row when there are more.
  function page(rows, n, moreId, moreTitle) {
    const start = (n - 1) * 9;
    if (rows.length <= 10 && n === 1) return rows;
    const slice = rows.slice(start, start + 9);
    return start + 9 < rows.length ? [...slice, row(moreId, moreTitle, `${rows.length - start - 9} more`)] : slice;
  }

  const priceText = (d) => d.items.map((i) => `${portionOf(i.name).portion ? `${portionOf(i.name).portion} ` : ''}${rupees(i.price)}`).join(' · ');

  function categoriesList(s, intro, n = 1) {
    const cats = orders.categories(s.outletId).filter((c) => c.items.some((i) => i.available));
    const rows = cats.map((c) => {
      const avail = c.items.filter((i) => i.available);
      return row(`cat:${c.name}`, c.name, `${groupDishes(avail).length} dishes · from ${rupees(Math.min(...avail.map((i) => i.price)))}`);
    });
    return [list(`${intro ? intro + '\n\n' : ''}What would you like to eat? 😋 Pick from the menu or just type your order.`, 'View menu',
      [{ title: 'Menu', rows: page(rows, n, `cats:${n + 1}`, 'More categories ➡️') }])];
  }

  // arg: "<category>" or "<category>|<page>"
  function itemsList(s, arg) {
    const [category, p] = String(arg).split('|');
    const n = Math.max(1, Number(p) || 1);
    const cat = orders.categories(s.outletId).find((c) => c.name === category);
    if (!cat) return categoriesList(s);
    const rows = groupDishes(cat.items.filter((i) => i.available)).map((d) => row(
      d.items.length > 1 ? `dish:${d.items[0].id}` : `item:${d.items[0].id}`, d.dish,
      `${d.veg ? '🟢' : '🔴'} ${priceText(d)}${d.dish.length > 24 ? ' · ' + d.dish : ''}`,
    ));
    return [list(`*${cat.name}*${n > 1 ? ` (page ${n})` : ''}\nPick a dish to add to your cart.`, 'Choose dish',
      [{ title: clip(cat.name, 24), rows: page(rows, n, `cat:${category}|${n + 1}`, 'More dishes ➡️') }])];
  }

  // Half or Full? Buttons for the portions of one dish (tapping goes on to "how many").
  function portionButtons(s, itemId, idPrefix = 'item') {
    const menu = orders.menuFor(s.outletId);
    const first = menu.find((i) => i.id === Number(itemId));
    if (!first) return null;
    const { dish } = portionOf(first.name);
    const options = menu.filter((i) => i.available && portionOf(i.name).dish === dish);
    return { dish, options, reply: buttons(`*${dish}*\nHalf or Full?`, options.map((i) => btn(`${idPrefix}:${i.id}`, `${portionOf(i.name).portion || 'Regular'} · ${rupees(i.price)}`))) };
  }

  function cartLines(s) {
    const menu = menuMap(s);
    return s.cart.filter((l) => menu.has(l.id)).map((l) => ({ ...l, item: menu.get(l.id) }));
  }

  // The cart as a numbered order slip: dish, portion, quantity, price, notes.
  function cartSummary(s) {
    const lines = cartLines(s);
    const body = lines.map((l, i) => {
      const { dish, portion } = portionOf(l.item.name);
      return `*${i + 1}.* ${dish}${portion ? ` · ${portion}` : ''} × ${l.qty} — *${rupees(l.item.price * l.qty)}*${l.note ? `\n      _${l.note}_` : ''}`;
    }).join('\n');
    const subtotal = lines.reduce((t, l) => t + l.item.price * l.qty, 0);
    const notes = s.orderNotes.length ? `\n📝 Kitchen note: ${s.orderNotes.join('; ')}` : '';
    return { lines, body: `${body}${notes}`, subtotal };
  }

  // The delivery charge as the customer should see it with their cart.
  function deliveryLine(s, subtotal) {
    if (s.fulfilment === 'pickup') return '🏃 Pickup: no delivery charge';
    const d = config.delivery;
    if (!s.outletId || s.distanceKm == null) {
      return `🛵 Delivery: ${rupees(d.baseFee)} for the first ${d.baseKm} km + ${rupees(d.perKmFee)}/km, worked out at checkout from your location`;
    }
    const fee = deliveryFee(subtotal, s.distanceKm);
    return `🛵 Delivery (${s.distanceKm} km): ${fee ? rupees(fee) : 'FREE'}`;
  }

  function cartView(s, heading = '🧾 *Your order so far*') {
    const { lines, body, subtotal } = cartSummary(s);
    if (!lines.length) return [buttons('Your cart is empty 🛒 Type your order or open the menu.', [btn('act:more', '📋 Menu')])];
    const outlet = s.outletId ? outletOf(s) : null;
    const rule = '━━━━━━━━━━━━━━';
    return longButtons(`${heading}${outlet ? `\n${outlet.name}` : ''}\n${rule}\n${body}\n${rule}\nItem total: *${rupees(subtotal)}*\n${deliveryLine(s, subtotal)}\n\n_Type more items to add, or *remove 2* to take out line 2._`, [
      btn('act:checkout', '✅ Checkout'),
      btn('act:more', '➕ Add more'),
      btn('act:clear', '🗑️ Clear cart'),
    ]);
  }

  function confirmView(s) {
    const outlet = outletOf(s);
    const qte = orders.quote({ outletId: s.outletId, items: s.cart, fulfilment: s.fulfilment, distanceKm: s.distanceKm || 0 });
    const lines = qte.lines.map((l, i) => {
      const { dish, portion } = portionOf(l.name);
      return `*${i + 1}.* ${dish}${portion ? ` · ${portion}` : ''} × ${l.qty} — ${rupees(l.price * l.qty)}${l.note ? `\n      _${l.note}_` : ''}`;
    }).join('\n');
    const charges = [
      `Item total: ${rupees(qte.subtotal)}`,
      `Packing: ${rupees(qte.packing)}`,
      `GST (5%): ${rupees(qte.gst)}`,
      ...(s.fulfilment === 'delivery' ? [`Delivery (${qte.deliveryKm} km): ${qte.deliveryFee ? rupees(qte.deliveryFee) : `FREE (saves ${rupees(qte.deliveryCharge)})`}`] : []),
    ].join('\n');
    const notes = s.orderNotes.length ? `\n📝 Note for kitchen: ${s.orderNotes.join('; ')}\n` : '';
    const where = s.fulfilment === 'delivery'
      ? `🛵 Delivery to: ${s.address}\nFrom: ${outlet.name}`
      : `🏃 Pickup from: ${outlet.name}\n${outlet.address}`;
    const later = s.fulfilment === 'delivery' ? 'delivery' : 'pickup';
    const summary = `*Please confirm your order*\n\n${lines}\n${notes}\n${charges}\n*To pay: ${rupees(qte.total)}*\n\n${where}`;
    if (canPayOnline(outlet)) {
      return longButtons(`${summary}\n\nHow would you like to pay?\n💳 *Pay now*: UPI QR / link for the exact amount\n💵 *Pay on ${later}*: cash or UPI to the rider${s.fulfilment === 'pickup' ? '/counter' : ''}\n\n(Type *cancel* to drop this order.)`, [
        btn('act:place_upi', '💳 Pay now (UPI)'),
        btn('act:place', s.fulfilment === 'delivery' ? '💵 Pay on delivery' : '💵 Pay at pickup'),
        btn('act:cart', '✏️ Edit cart'),
      ]);
    }
    return longButtons(`${summary} (cash/UPI on ${later})`, [
      btn('act:place', '✅ Place order'),
      btn('act:cart', '✏️ Edit cart'),
      btn('act:cancel', '❌ Cancel'),
    ]);
  }

  function trackView(phone) {
    const o = orders.latestOrderForPhone(phone);
    if (!o) return [text("You don't have any orders yet. Send *hi* to start ordering.")];
    const tracking = text(`📦 Order *${o.code}*: ${o.statusLabel}\nFrom ${o.outlet.name} (${o.outlet.phone})\nTotal ${rupees(o.total)} · ${o.paymentLabel}\n\nTrack: ${baseUrl}/track.html?code=${o.code}`);
    return o.payment_status === 'pending' && !['unpaid', 'cancelled'].includes(o.status) ? [tracking, ...payView(o)] : [tracking];
  }

  // Ask the customer to pick between variants of something they typed: first
  // the dish ("veg steam momo" or "veg fried momo"), then Half or Full.
  function choiceView(s) {
    const c = s.choices[0];
    s.state = 'await_choice';
    const ask = `${c.qty > 1 ? ` (×${c.qty})` : ''}${c.note ? ` _(${c.note})_` : ''}`;
    const dishes = groupDishes(c.options);
    if (dishes.length === 1) {
      const d = dishes[0];
      return [buttons(`*${d.dish}*${ask}\nHalf or Full?`, d.items.map((o) => btn(`pick:${o.id}`, `${portionOf(o.name).portion || 'Regular'} · ${rupees(o.price)}`)))];
    }
    const prompt = `Which *${c.query}* would you like?${ask}`;
    if (dishes.length <= 3 && dishes.every((d) => d.items.length === 1)) {
      return [buttons(prompt, dishes.map((d) => btn(`pick:${d.items[0].id}`, d.dish)))];
    }
    const rows = dishes.slice(0, 10).map((d) => row(d.items.length > 1 ? `pickdish:${d.items[0].id}` : `pick:${d.items[0].id}`, d.dish,
      `${d.veg ? '🟢' : '🔴'} ${priceText(d)}${d.dish.length > 24 ? ' · ' + d.dish : ''}`));
    return [list(prompt, 'Choose', [{ title: 'Options', rows }])];
  }

  // After items are added by text or catalog: resolve questions, then show the
  // cart. Location is only asked once, at checkout.
  function nextStep(s, intro = []) {
    if (s.choices.length) return [...intro, ...choiceView(s)];
    s.state = 'browsing';
    return [...intro, ...cartView(s)];
  }

  // Checkout needs an outlet (e.g. the customer typed an order straight away):
  // ask delivery/pickup and where, then carry on with checkout.
  function askWhere(s) {
    s.checkingOut = true;
    if (s.fulfilment === 'pickup') return pickupStart(s, new Date());
    if (s.fulfilment === 'delivery') return askDelivery(s, 'Almost done! 🙌 ');
    return [buttons('Almost done! 🙌 Delivery or pickup?', [btn('mode:delivery', '🛵 Delivery'), btn('mode:pickup', '🏃 Pickup')])];
  }

  // Once the outlet is known: drop anything sold out there, then resume checkout if that's where we were.
  function afterOutletKnown(s, intro) {
    const dropped = dropUnavailable(s);
    if (s.checkingOut && s.cart.length) return [text(intro), ...dropped, ...checkout(s)];
    return [text(intro), ...dropped, ...nextStep(s)];
  }

  // ---- Actions -----------------------------------------------------------

  function onLocation(s, loc, now) {
    s.lat = loc.lat;
    s.lng = loc.lng;
    if (s.fulfilment === 'pickup') return pickupSuggest(s, now);
    return deliverTo(s, loc, now, { pin: true });
  }

  // Delivery checks for a point: in range of an open outlet? Then pick it.
  function deliverTo(s, loc, now, { pin = false, area = null } = {}) {
    s.fulfilment = 'delivery';
    s.lat = loc.lat;
    s.lng = loc.lng;
    const a = assignOutlet(orders.listOutlets(), loc, { fulfilment: 'delivery', now });
    if (a.outlet) {
      s.outletId = a.outlet.id;
      s.distanceKm = a.distanceKm;
      const intro = `✅ We deliver to ${area ? `*${area}*` : 'you'}! *${a.outlet.name}* (${a.distanceKm} km away) will cook your order, about ${etaMinutes('delivery', a.distanceKm)} min.\n🛵 Delivery: *${rupees(deliveryCharge(a.distanceKm))}*`
        + (area ? '\n_(Placed from your address. Share your location pin anytime for the exact spot.)_' : '');
      if (pin && !s.address) {
        // Location pin only: get the house/flat details for the rider now.
        s.state = 'await_address_start';
        return [text(`${intro}\n\n🏠 Now please type your full address (house/flat no., street, landmark) so the rider finds you.`)];
      }
      return readyMenu(s, intro);
    }
    s.state = 'await_location';
    const alt = a.pickupSuggestion;
    const msg = a.reason === 'closed'
      ? '😔 Sorry, the outlets that deliver to you are closed right now.'
      : "😔 Sorry, we don't deliver to this location yet.";
    if (!alt) return [text(`${msg} All our outlets are closed at the moment. Please try again during opening hours.`)];
    return [buttons(`${msg}\n\nYou can pick up from *${alt.outlet.name}* (${alt.distanceKm} km away), or send a different location.`, [
      btn(`outlet:${alt.outlet.id}`, 'Pickup instead'),
      btn('act:relocate', 'Another location'),
    ])];
  }

  // The cart may have been filled before we knew the outlet; remove sold-out items.
  function dropUnavailable(s) {
    const menu = menuMap(s);
    const gone = s.cart.filter((l) => !menu.get(l.id)?.available);
    if (!gone.length) return [];
    s.cart = s.cart.filter((l) => menu.get(l.id)?.available);
    const names = gone.map((l) => menu.get(l.id)?.name || 'an item').join(', ');
    return [text(`😔 Sorry, ${names} ${gone.length > 1 ? 'are' : 'is'} sold out at ${outletOf(s).name} right now, so I've removed ${gone.length > 1 ? 'them' : 'it'}.`)];
  }

  function addToCart(s, qty, note = '') {
    const item = orders.menuFor(s.outletId).find((i) => i.id === s.pendingItemId);
    s.pendingItemId = null;
    s.state = 'browsing';
    if (!item || !item.available) return [text('Sorry, that item is not available right now.'), ...categoriesList(s)];
    addLine(s, item.id, qty, note);
    const count = s.cart.reduce((t, l) => t + l.qty, 0);
    return [buttons(`Added ${qty} × *${describe(item.name, note)}* ✅\nCart: ${count} item${count > 1 ? 's' : ''}\n\n_Tip: you can add instructions, e.g. reply "2 less spicy"._`, [
      btn('act:more', '➕ Add more'),
      btn('act:cart', '🛒 View cart'),
      btn('act:checkout', '✅ Checkout'),
    ])];
  }

  // Free-text order: "2 half kurkure veg momo less spicy, 1 full veg noodles no onion".
  function onTypedOrder(s, parsed) {
    const menu = menuMap(s);
    const added = [];
    const soldOut = [];
    for (const l of parsed.lines) {
      const item = menu.get(l.id);
      if (s.outletId && !item.available) { soldOut.push(item.name); continue; }
      addLine(s, l.id, l.qty, l.note);
      added.push(`• ${l.qty} × ${describe(item.name, l.note)}`);
    }
    s.choices.push(...parsed.choices.map((c) => ({ ...c, options: c.options.filter((o) => !s.outletId || o.available).map(({ id, name, price, veg }) => ({ id, name, price, veg })) }))
      .filter((c) => c.options.length));
    s.orderNotes.push(...parsed.orderNotes);
    const parts = [];
    if (added.length) parts.push(`Got it 👍\n${added.join('\n')}`);
    if (parsed.orderNotes.length) parts.push(`📝 Noted for the kitchen: ${parsed.orderNotes.join('; ')}`);
    if (soldOut.length) parts.push(`😔 ${soldOut.join(', ')} ${soldOut.length > 1 ? 'are' : 'is'} sold out at this outlet right now.`);
    if (parsed.unknown.length) parts.push(`🤔 I couldn't find "${parsed.unknown.join('", "')}" on our menu. Type *menu* to see everything, or *talk to us* for something special.`);
    return nextStep(s, parts.length ? [text(parts.join('\n\n'))] : []);
  }

  // Cart sent from the WhatsApp catalog (one catalog for all outlets).
  function onCatalogOrder(s, msg) {
    const menu = menuMap(s);
    const lines = (msg.items || [])
      .map((p) => ({ id: Number(String(p.retailerId).replace(CATALOG_PREFIX, '')), qty: Math.max(1, Math.min(Number(p.qty) || 1, MAX_QTY)) }))
      .filter((l) => menu.has(l.id));
    if (!lines.length) return [text("Sorry, I couldn't read that cart. Please type your order or type *menu*.")];
    s.cart = [];
    for (const l of lines) addLine(s, l.id, l.qty);
    if (msg.text) s.orderNotes.push(String(msg.text).slice(0, 200));
    const intro = [text(`🛒 Got your cart: ${lines.length} item${lines.length > 1 ? 's' : ''}.${msg.text ? `\n📝 ${msg.text}` : ''}`)];
    if (s.outletId) intro.push(...dropUnavailable(s));
    return nextStep(s, intro);
  }

  // Typed address: place it on the map from known areas, or ask for a pin.
  function onTypedAddress(s, raw, now) {
    s.address = raw.slice(0, 300);
    const r = placeAddress(raw, places());
    if (r.place) return deliverTo(s, r.place, now, { area: `${r.place.name}, ${r.place.city}` });
    if (r.candidates) {
      s.areaChoices = r.candidates;
      s.state = 'await_area';
      return [buttons('🏠 Address saved. Which area is it in?', r.candidates.map((c, i) => btn(`area:${i}`, `${c.name}, ${c.city}`)))];
    }
    return [{
      type: 'location_request',
      text: "🏠 Thanks, I've saved your address. I couldn't place it on the map, though.\n\nPlease tap *Send location* to share your location pin 📍 so we pick the right outlet, or type your area and city.",
    }];
  }

  function checkout(s) {
    if (!cartLines(s).length) return s.outletId ? cartView(s) : welcome();
    if (!s.outletId) return askWhere(s);
    s.checkingOut = false;
    const qte = orders.quote({ outletId: s.outletId, items: s.cart, fulfilment: s.fulfilment, distanceKm: s.distanceKm || 0 });
    if (s.fulfilment === 'delivery' && qte.subtotal < config.pricing.minDeliveryOrder) {
      return [buttons(`Minimum order for delivery is ${rupees(config.pricing.minDeliveryOrder)}. Your item total is ${rupees(qte.subtotal)}.`, [
        btn('act:more', '➕ Add more'),
      ])];
    }
    if (s.fulfilment === 'delivery' && s.address) {
      // Address was given at the start; confirm with it (type "change address" to edit).
      s.state = 'confirm';
      return confirmView(s);
    }
    if (s.fulfilment === 'delivery') {
      s.state = 'await_address';
      const prompt = 'Please type your complete delivery address 🏠\n(House/flat no., street/sector, landmark)';
      return s.address
        ? [buttons(`${prompt}\n\nOr use your last address:\n_${s.address}_`, [btn('act:same_address', 'Use this address')])]
        : [text(prompt)];
    }
    s.state = 'confirm';
    return confirmView(s);
  }

  // UPI request for an order: QR image plus a link that opens the customer's UPI app.
  function payView(order) {
    const page = `${baseUrl}/track.html?code=${order.code}`;
    const outlet = orders.getOutlet(order.outlet_id);
    const qrImage = (text) => ({ type: 'image', url: `${baseUrl}/pay/${order.code}/qr.png`, svg: qrSvg(order.upi.link), text });
    // Payment gateway: one link (UPI app, QR or card) that confirms itself. WhatsApp's
    // own "Review and pay" still comes first where it is set up.
    if (order.upi.gateway) {
      const inChat = config.whatsapp.payments && outlet?.wa_payment_config;
      return [
        ...(inChat ? [orderDetailsReply(order, outlet, { goodsType: config.whatsapp.goodsType })] : []),
        qrImage(`Paying from another phone? Scan to pay ${rupees(order.total)} · Order ${order.code}`),
        buttons(`💳 *Pay ${rupees(order.total)}*${inChat ? ' with *Review and pay* above, or here' : ''}:\n👉 ${order.upi.link}\n\nAny UPI app (GPay, PhonePe, Paytm, BHIM) or a card. Your order is confirmed here automatically the moment you pay.`, [
          btn('act:pay_cash', '💵 Pay cash instead'),
        ]),
      ];
    }
    if (config.whatsapp.payments && outlet?.wa_payment_config) {
      // In-chat payment: WhatsApp's own UPI or any UPI app, confirmed by WhatsApp.
      // The dynamic QR (this order, this amount) covers paying from another phone.
      return [
        orderDetailsReply(order, outlet, { goodsType: config.whatsapp.goodsType }),
        qrImage(`Paying from another phone? Scan to pay ${rupees(order.total)} to ${order.upi.payee} (${order.upi.upiId}) · Order ${order.code}`),
        buttons(`💳 Tap *Review and pay* above to pay ${rupees(order.total)} with WhatsApp's UPI or any UPI app on this phone. We'll confirm here automatically.\n\nPaid by scanning the QR instead? Tap *I've paid*.`, [
          btn('act:paid', "✅ I've paid by QR"),
          btn('act:pay_cash', '💵 Pay cash instead'),
        ]),
      ];
    }
    return [
      { type: 'image', url: `${baseUrl}/pay/${order.code}/qr.png`, svg: qrSvg(order.upi.link), text: `Scan to pay ${rupees(order.total)} to ${order.upi.payee} (${order.upi.upiId}) · Order ${order.code}` },
      buttons(`💳 *Pay ${rupees(order.total)} by UPI*\n\nOn this phone, open 👉 ${page}\nand tap *Pay with UPI app*. GPay, PhonePe, Paytm or BHIM opens with the amount filled in.\nOr scan the QR above from another phone.\n\nWhen done, tap *I've paid* or send the payment screenshot here.`, [
        btn('act:paid', "✅ I've paid"),
        btn('act:pay_cash', '💵 Pay cash instead'),
      ]),
    ];
  }

  // WhatsApp reports the result of a "Review and pay" payment.
  function onPayment(msg, now) {
    const o = orders.getOrder(msg.referenceId);
    // Only accept results for this customer's own order.
    if (!o || (msg.from && o.phone.replace(/\D/g, '') !== String(msg.from).replace(/\D/g, ''))) return [];
    if (['success', 'captured'].includes(msg.status)) {
      if (o.payment_status === 'paid') return [];
      if (msg.amount != null && msg.amount !== o.total) {
        // Never mark an order paid for the wrong amount; staff check it.
        if (o.payment_status === 'pending') orders.setPayment(o.code, 'claimed', now, 'whatsapp');
        return [text(`We received ${rupees(msg.amount)} for order *${o.code}*, but the bill is ${rupees(o.total)}. ${o.outlet.name} will check and get back to you.`)];
      }
      const paid = orders.setPayment(o.code, 'paid', now, 'whatsapp');
      const ref = msg.transactionId ? ` (UPI ref ${msg.transactionId})` : '';
      if (paid.status !== 'placed' || !['awaiting_payment', 'unpaid'].includes(o.status)) {
        return [text(`✅ Payment of ${rupees(o.total)} received for order *${o.code}*${ref}. Thank you! 🙏`)];
      }
      return [text(`✅ Payment of ${rupees(o.total)} received${ref}.\n\n${confirmedBody(paid)}`), ...afterConfirm(paid)];
    }
    if (['failed', 'canceled', 'cancelled', 'expired'].includes(msg.status) && ['pending', 'claimed'].includes(o.payment_status)) {
      return [buttons(`⚠️ Your UPI payment for order *${o.code}* didn't go through. No money was taken.\nTry again, or pay ${rupees(o.total)} by cash/UPI ${o.fulfilment === 'delivery' ? 'on delivery' : 'at pickup'}.`, [
        btn('act:pay_again', '🔁 Try again'),
        btn('act:pay_cash', '💵 Pay cash instead'),
      ])];
    }
    return [];
  }

  // Confirmation once an order goes to the kitchen (paid online or switched to cash).
  function confirmedBody(o) {
    const willEarn = crm ? crm.pointsFor(o.total) : 0;
    const loyalty = willEarn ? `\n⭐ You'll earn *${willEarn} loyalty point${willEarn > 1 ? 's' : ''}* when it's ${o.fulfilment === 'delivery' ? 'delivered' : 'picked up'}.` : '';
    return `${orderConfirmedText(o)}\n\nTrack your order: ${baseUrl}/track.html?code=${o.code}\nOutlet phone: ${o.outlet.phone}${loyalty}`;
  }
  const afterConfirm = (o) => (crm && !crm.optedIn(o.phone) ? optInAsk() : []);

  // Ask once for permission to send offers (needed for WhatsApp campaigns).
  function optInAsk() {
    return [buttons('🎁 Want our offers, new dishes and loyalty updates here on WhatsApp? You can stop anytime by typing *stop offers*.', [
      btn('act:optin_yes', '✅ Yes, send offers'),
      btn('act:optin_no', 'No thanks'),
    ])];
  }

  function pointsView(phone) {
    if (!crm) return [text('Loyalty points are not available right now.')];
    const c = crm.pointsSummary(phone);
    if (!c) return [text(`⭐ You don't have any points yet. Earn 1 point for every ₹${config.loyalty.rupeesPerPoint} you spend. Type *hi* to order.`)];
    const recent = c.ledger.slice(0, 3).map((l) => `${l.points > 0 ? '+' : ''}${l.points} · ${l.note || l.kind}`).join('\n');
    return [text(`⭐ You have *${c.points} loyalty points*.\nYou earn 1 point for every ₹${config.loyalty.rupeesPerPoint} spent. Show this chat at the outlet to redeem.${recent ? `\n\nRecent:\n${recent}` : ''}`)];
  }

  function latestUnpaid(phone) {
    const o = orders.latestOrderForPhone(phone);
    return o && ['pending', 'claimed'].includes(o.payment_status) && !['unpaid', 'cancelled', 'completed'].includes(o.status) ? o : null;
  }

  function place(s, msg, now, paymentMethod = 'cod') {
    try {
      const order = orders.createOrder({
        channel: 'whatsapp',
        fulfilment: s.fulfilment,
        name: msg.name || 'WhatsApp customer',
        phone: msg.from,
        address: s.address,
        lat: s.lat,
        lng: s.lng,
        outletId: s.outletId,
        notes: s.orderNotes.join('; '),
        items: s.cart,
        paymentMethod,
      }, now);
      s.cart = [];
      s.orderNotes = [];
      s.state = 'browsing';
      const willEarn = crm ? crm.pointsFor(order.total) : 0;
      const loyalty = willEarn ? `\n⭐ You'll earn *${willEarn} loyalty point${willEarn > 1 ? 's' : ''}* when it's delivered.` : '';
      const optIn = crm && !crm.optedIn(order.phone) ? optInAsk() : [];
      if (order.payment_method === 'upi') {
        // Not placed yet: the kitchen gets it once the payment is in.
        return [text(`🧾 Your order *${order.code}* is ready to go. *Pay ${rupees(order.total)} to confirm it*: the kitchen starts as soon as your payment arrives.\n\n(Not paid within ${config.payments.windowMinutes} minutes? We cancel it and nothing is charged.)`), ...payView(order)];
      }
      return [text(`🎉 Order placed! Your order ID is *${order.code}*.\n\n${order.outlet.name} will ${order.fulfilment === 'delivery' ? `deliver in about ${order.etaMinutes} min` : `have it ready in about ${order.etaMinutes} min`}.\nPay ${rupees(order.total)} by cash/UPI on ${order.fulfilment === 'delivery' ? 'delivery' : 'pickup'}.${loyalty}\n\nTrack your order: ${baseUrl}/track.html?code=${order.code}\nOutlet phone: ${order.outlet.phone}\n\nWe'll message you here as your order moves along. Thank you! 🙏`), ...optIn];
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      s.state = 'browsing';
      return [buttons(`⚠️ ${e.message}`, [btn('act:cart', '🛒 View cart'), btn('act:relocate', '📍 Change location')])];
    }
  }

  // ---- Human handoff -----------------------------------------------------

  function startHandoff(s, msg, now) {
    if (!handoffs) {
      const o = outletOf(s);
      return [text(`Please call us${o ? ` at ${o.name}: ${o.phone}` : ''} and our team will help you. 🙏`)];
    }
    let outletId = s.outletId;
    if (!outletId && s.lat != null) outletId = assignOutlet(orders.listOutlets(), s, { fulfilment: 'pickup', now }).outlet?.id || null;
    const { body } = cartSummary(s);
    const context = [
      `Started by ${msg.type === 'reply' ? 'tapping "Talk to us"' : `message: "${msg.text}"`}`,
      s.fulfilment ? `Mode: ${s.fulfilment}` : null,
      s.address ? `Address: ${s.address}` : null,
      s.cart.length ? `Cart:\n${body.replace(/[_*]/g, '')}` : null,
    ].filter(Boolean).join('\n');
    handoffs.open({ phone: msg.from, name: msg.name, outletId, context }, now);
    const outlet = outletId ? orders.getOutlet(outletId) : null;
    s.state = 'human';
    return [text(`🙋 Connecting you to our team${outlet ? ` at *${outlet.name}*` : ''}. Tell us what you need: special requests, bulk or party orders, a problem with an order, anything. A team member will reply here shortly.\n\n(Type *bot* anytime to go back to quick ordering.)`)];
  }

  function relayToHuman(h, msg) {
    const body = msg.type === 'text' ? msg.text
      : msg.type === 'location' ? `📍 Shared location: https://maps.google.com/?q=${msg.location.lat},${msg.location.lng}`
        : msg.type === 'reply' ? `[tapped ${msg.replyId}]`
          : msg.type === 'catalog_order' ? `[sent a catalog cart with ${(msg.items || []).length} items]`
            : msg.type === 'image' ? `📷 [sent a photo${msg.text ? `: ${msg.text}` : ''}]`
            : '[sent an unsupported message]';
    handoffs.addMessage(h.id, 'in', body);
    return [];
  }

  // ---- Router ------------------------------------------------------------

  function route(s, msg, now) {
    const raw = (msg.text || '').trim();
    const t = raw.toLowerCase();

    // Payment results are handled even while a person is on the chat.
    if (msg.type === 'payment') return onPayment(msg, now);

    // A person is handling this chat: pass messages through, stay quiet.
    const open = handoffs && handoffs.openForPhone(msg.from);
    if (open) {
      if (msg.type === 'text' && BACK_TO_BOT.includes(t)) {
        handoffs.addMessage(open.id, 'in', raw);
        handoffs.close(open.id, now);
        s.state = 'browsing';
        return [text("You're back with the ordering assistant 🤖"), ...(s.outletId ? (s.cart.length ? cartView(s) : categoriesList(s)) : welcome(msg.name))];
      }
      return relayToHuman(open, msg);
    }

    if (msg.type === 'location') return onLocation(s, msg.location, now);
    if (msg.type === 'catalog_order') return onCatalogOrder(s, msg);

    if (msg.type === 'text') {
      if (['reset', 'cancel', 'restart', 'start over'].includes(t)) {
        Object.assign(s, freshSession());
        return [text('Okay, starting fresh. 👍'), ...welcome(msg.name)];
      }
      if (['track', 'status', 'order status', 'where is my order'].includes(t)) return trackView(msg.from);
      if (['points', 'my points', 'loyalty', 'rewards'].includes(t)) return pointsView(msg.from);
      // Review template button (web orders) or typed "review RCXXXX".
      const rv = t.match(/^review[: ]\s*([a-z]{1,3}[2-9a-z]{6})$/i);
      if (rv && reviews) return reviews.start(rv[1].toUpperCase(), msg.from) || [text("I couldn't find that order to review.")];
      if (s.state === 'await_review_comment' && reviews && !HUMAN_RE.test(t)) {
        reviews.comment(s.reviewCode, raw, msg.from, now);
        s.state = 'browsing';
        return reviews.thanks();
      }
      if (['stop offers', 'stop', 'unsubscribe'].includes(t) && crm) {
        crm.update(msg.from, { optIn: false });
        return [text("👍 Done. We won't send you offers. You'll still get updates about your orders.")];
      }
      if (['checkout', 'check out', 'place order', 'done', "that's all", 'thats all'].includes(t) && s.cart.length) return checkout(s);
      // "remove 2" / "hatao 2": drop that line of the order slip.
      const rm = t.match(/^(?:remove|delete|hatao|hata do|hata|cancel)\s+(?:line\s+|item\s+|no\.?\s*)?(\d{1,2})$/);
      if (rm && s.cart.length) {
        const line = cartLines(s)[Number(rm[1]) - 1];
        if (!line) return [text(`There's no line ${rm[1]} in your order.`), ...cartView(s)];
        s.cart = s.cart.filter((l) => !(l.id === line.id && (l.note || '') === (line.note || '')));
        return [text(`Removed ${line.qty} × ${line.item.name} ✅`), ...cartView(s)];
      }
      if (t === 'cart') return s.outletId || s.cart.length ? cartView(s) : welcome(msg.name);
      if (['menu', 'order'].includes(t)) return s.outletId ? menuView(s) : welcome(msg.name);
      if (['change address', 'new address', 'change location'].includes(t)) {
        s.state = 'await_address';
        return [text('🏠 Please type the new delivery address (house/flat no., street, landmark).')];
      }
      if (s.state === 'await_qty') {
        const m = t.match(/^(\d{1,2})\b\s*(.*)$/);
        if (m && Number(m[1]) >= 1) return addToCart(s, Math.min(Number(m[1]), MAX_QTY), raw.slice(m[0].length - m[2].length).trim().slice(0, 120));
      }
      if (s.state === 'await_address') {
        if (t.length < 5) return [text('That address looks too short. Please include house/flat no., sector/street and a landmark.')];
        s.address = raw.slice(0, 300);
        if (!s.outletId) return onTypedAddress(s, raw, now);
        s.state = 'confirm';
        return confirmView(s);
      }
      if (s.state === 'await_address_start' && !parseOrderText(raw, orders.menuFor(s.outletId)).isOrder) {
        if (t.length < 5) return [text('That address looks too short. Please include house/flat no., street and a landmark.')];
        s.address = raw.slice(0, 300);
        return readyMenu(s, '🏠 Thanks, address saved.');
      }
      // Delivery location step: a typed message is the address.
      if (s.state === 'await_location' && s.fulfilment === 'delivery' && t.length >= 6 && !parseOrderText(raw, orders.menuFor(null)).isOrder) {
        return onTypedAddress(s, raw, now);
      }
      if (HUMAN_RE.test(t) || t === 'help') return startHandoff(s, msg, now);
      if (s.state === 'await_choice' && s.choices.length) {
        const pick = s.choices[0].options.find((o) => o.name.toLowerCase().includes(t));
        if (pick) return route(s, { ...msg, type: 'reply', replyId: `pick:${pick.id}` }, now);
      }

      const parsed = parseOrderText(raw, orders.menuFor(s.outletId));
      if (parsed.isOrder) return onTypedOrder(s, parsed);
      if (parsed.orderNotes.length && (s.cart.length || s.outletId)) {
        s.orderNotes.push(...parsed.orderNotes);
        return [text(`📝 Noted: ${parsed.orderNotes.join('; ')}`), ...cartView(s)];
      }
      if (['hi', 'hii', 'hello', 'hey', 'namaste', 'sat sri akal'].includes(t)) {
        return s.cart.length ? [text(`Welcome back${msg.name ? ' ' + msg.name : ''}! Your cart is saved.`), ...cartView(s)] : welcome(msg.name);
      }
      if (s.state === 'await_location') return askLocation();
      if (s.state === 'choose_outlet') return pickupOutlets(now, s.lat != null ? s : null);
      if (parsed.unknown.length) {
        return [buttons(`🤔 Sorry, I couldn't find "${parsed.unknown.join('", "')}" on our menu.\n\nWant to talk to our team about it? They can help with special requests.`, [
          btn('act:human', '💬 Talk to us'), btn('act:more', '📋 Menu'),
        ])];
      }
      if (!s.outletId) return welcome(msg.name);
      return [buttons("Sorry, I didn't get that. 🙂 Type your order, use the buttons below, or type *track* or *reset*.", [
        btn('act:more', '📋 Menu'), btn('act:cart', '🛒 View cart'), btn('act:human', '💬 Talk to us'),
      ])];
    }

    if (msg.type === 'image') {
      // Most photos at this point are UPI payment screenshots.
      const o = latestUnpaid(msg.from);
      if (o) {
        orders.claimPayment(o.code, now);
        return [text(`📸 Got your payment screenshot for order *${o.code}*. ${o.outlet.name} will confirm as soon as ${rupees(o.total)} shows in their UPI account. 🙏`)];
      }
      return [buttons('Thanks for the photo! If you need help with something, our team can take a look.', [btn('act:human', '💬 Talk to us'), btn('act:more', '📋 Menu')])];
    }

    if (msg.type !== 'reply') return [text('Sorry, I can only understand text, buttons and shared locations. Type *hi* to start.')];

    const [kind, arg] = msg.replyId.split(/:(.*)/s);
    // The menu comes after delivery/pickup and outlet are settled; placing needs them too.
    const needsOutlet = ['cat', 'item', 'qty'].includes(kind) || ['more', 'place', 'place_upi', 'same_address'].includes(arg);
    if (needsOutlet && !s.outletId) return s.cart.length ? checkout(s) : (s.fulfilment ? askWhere(s) : welcome(msg.name));

    switch (kind) {
      case 'mode':
        if (arg === 'pickup') return pickupStart(s, now);
        s.outletId = null;
        s.distanceKm = null;
        if (s.address && s.lat != null) {
          // Returning customer this session: offer the last address.
          s.fulfilment = 'delivery';
          s.state = 'await_location';
          return [buttons(`🛵 Deliver to your last address?\n_${s.address}_`, [btn('act:same_place', '📍 Same address'), btn('act:new_place', '🆕 New address')])];
        }
        s.address = null;
        return askDelivery(s);
      case 'area': {
        const c = s.areaChoices[Number(arg)];
        if (!c) return askDelivery(s);
        s.areaChoices = [];
        return deliverTo(s, c, now, { area: `${c.name}, ${c.city}` });
      }
      case 'outlet': {
        const o = orders.getOutlet(Number(arg));
        if (!o) return pickupOutlets(now);
        if (!isOpen(o, now)) return [text(`${o.name} is closed right now (open ${o.opens}–${o.closes}).`), ...pickupOutlets(now)];
        s.fulfilment = 'pickup';
        s.outletId = o.id;
        s.distanceKm = null;
        s.state = 'browsing';
        const intro = `🏃 Pickup from *${o.name}*\n${o.address}`;
        if (!s.cart.length) return menuView(s, intro);
        return afterOutletKnown(s, intro);
      }
      case 'cat':
        return itemsList(s, arg);
      case 'cats':
        return categoriesList(s, '', Math.max(1, Number(arg) || 1));
      case 'dish': {
        const p = portionButtons(s, arg);
        if (!p || !p.options.length) return [text('Sorry, that dish is not available right now.'), ...categoriesList(s)];
        if (p.options.length === 1) return route(s, { ...msg, type: 'reply', replyId: `item:${p.options[0].id}` }, now);
        return [p.reply];
      }
      case 'item': {
        const item = orders.menuFor(s.outletId).find((i) => i.id === Number(arg));
        if (!item || !item.available) return [text('Sorry, that item is not available right now.'), ...categoriesList(s)];
        s.pendingItemId = item.id;
        s.state = 'await_qty';
        return [buttons(`*${item.name}* — ${rupees(item.price)}\nHow many? Tap below, or type a number with any instructions, e.g. _2 less spicy_.`, [btn('qty:1', '1'), btn('qty:2', '2'), btn('qty:3', '3')])];
      }
      case 'qty':
        if (!s.pendingItemId) return categoriesList(s);
        return addToCart(s, Math.max(1, Math.min(Number(arg) || 1, MAX_QTY)));
      case 'rate': {
        // rate:<code>:<itemId|0>:<stars>
        const [code, itemId, stars] = arg.split(':');
        const r = reviews && reviews.rate(code, itemId, stars, msg.from, now);
        if (!r) return [text('Thanks! This order was already reviewed or is not yours to review.')];
        if (r.askComment) { s.state = 'await_review_comment'; s.reviewCode = code; }
        return r.replies;
      }
      case 'rev_skip':
        s.state = 'browsing';
        return reviews ? reviews.thanks() : [];
      case 'pickdish': {
        // A dish picked from a typed-order question: narrow to its portions.
        const c = s.choices[0];
        const chosen = c && c.options.find((o) => o.id === Number(arg));
        if (!chosen) return s.outletId ? cartView(s) : welcome(msg.name);
        c.options = c.options.filter((o) => portionOf(o.name).dish === portionOf(chosen.name).dish);
        return choiceView(s);
      }
      case 'pick': {
        const c = s.choices.shift();
        if (!c) return s.outletId ? cartView(s) : welcome(msg.name);
        const option = c.options.find((o) => o.id === Number(arg));
        if (!option) { s.choices.unshift(c); return choiceView(s); }
        addLine(s, option.id, c.qty, c.note);
        return nextStep(s, [text(`Added ${c.qty} × ${describe(option.name, c.note)} ✅`)]);
      }
      case 'act':
        switch (arg) {
          case 'more': s.state = 'browsing'; return categoriesList(s);
          case 'browse': s.state = 'browsing'; return categoriesList(s);
          case 'cart': s.state = 'browsing'; return cartView(s);
          case 'clear': s.cart = []; s.orderNotes = []; s.choices = []; s.state = 'browsing'; return [text('Cart cleared. 🗑️'), ...(s.outletId ? categoriesList(s) : welcome(msg.name))];
          case 'checkout': return checkout(s);
          case 'same_address':
            if (!s.address) return checkout(s);
            s.state = 'confirm';
            return confirmView(s);
          case 'place':
          case 'place_upi':
            if (s.state !== 'confirm') return checkout(s);
            return place(s, msg, now, arg === 'place_upi' ? 'upi' : 'cod');
          case 'paid': {
            const o = latestUnpaid(msg.from);
            if (!o) return [text("You don't have a UPI payment waiting. Type *track* to see your order.")];
            orders.claimPayment(o.code, now);
            return [text(o.status === 'awaiting_payment'
              ? `🙏 Thank you! ${o.outlet.name} is checking for ${rupees(o.total)} in their UPI account. Your order goes to the kitchen as soon as they see it, and we'll message you here.`
              : `🙏 Thank you! ${o.outlet.name} will confirm as soon as ${rupees(o.total)} shows in their UPI account. We'll message you here.`)];
          }
          case 'optin_yes':
            if (crm) crm.update(msg.from, { optIn: true });
            return [text("🎉 You're in! We'll send offers and loyalty updates here. Type *points* anytime to see your points.")];
          case 'optin_no':
            return [text('No problem. 🙂 Type *points* anytime to see your loyalty points.')];
          case 'pay_again': {
            const o = latestUnpaid(msg.from);
            if (!o) return [text("You don't have a UPI payment waiting. Type *track* to see your order.")];
            return payView(o);
          }
          case 'pay_cash': {
            const o = latestUnpaid(msg.from);
            if (!o) return [text("You don't have a UPI payment waiting. Type *track* to see your order.")];
            const cash = orders.setPayment(o.code, 'cod', now, 'customer');
            const pay = `👍 No problem, pay ${rupees(o.total)} by cash/UPI ${o.fulfilment === 'delivery' ? 'when your order arrives' : 'at pickup'}.`;
            return o.status === 'awaiting_payment' ? [text(`${pay}\n\n${confirmedBody(cash)}`), ...afterConfirm(cash)] : [text(pay)];
          }
          case 'cancel': s.state = 'browsing'; return [text('No problem, your order was not placed. Your cart is still saved.'), ...cartView(s)];
          case 'track': return trackView(msg.from);
          case 'human': return startHandoff(s, msg, now);
          case 'relocate': s.address = null; return askDelivery(s);
          case 'same_place': return deliverTo(s, { lat: s.lat, lng: s.lng }, now);
          case 'new_place': s.address = null; return askDelivery(s);
          case 'outlets': s.state = 'choose_outlet'; return pickupOutlets(now, s.lat != null ? s : null);
          default: return welcome(msg.name);
        }
      default:
        return welcome(msg.name);
    }
  }

  /**
   * Handle one incoming message.
   * msg: { from, name?, type: 'text'|'location'|'reply'|'catalog_order'|'unsupported',
   *        text?, location?: {lat, lng}, replyId?, items?: [{retailerId, qty}] }
   */
  function handle(msg, now = new Date()) {
    const s = load(msg.from, now.getTime());
    let replies;
    try {
      replies = route(s, msg, now);
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      replies = [text(`⚠️ ${e.message}`), ...(s.outletId ? cartView(s) : welcome(msg.name))];
    }
    sessions.set(msg.from, s, now);
    return replies;
  }

  return { handle };
}

/** Conversation state per customer, kept in the store. */
function createSessionStore(store) {
  return {
    get: (phone) => store.getSession(phone),
    set: (phone, data, now = new Date()) => store.putSession(phone, data, now.toISOString()),
  };
}

module.exports = { createBot, createSessionStore, CATALOG_PREFIX };
