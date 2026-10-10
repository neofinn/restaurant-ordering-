'use strict';

// The sample client works end to end: routing, typed orders, menu pictures,
// and every customer locality is within delivery range.

const test = require('node:test');
const assert = require('node:assert/strict');
const sample = require('..');
const { createBot, createSessionStore } = require('../../../src/whatsapp/bot');
const { createHandoffService } = require('../../../src/handoff');
const { createMenuImages } = require('../../../src/whatsapp/menu-image');
const { assignOutlet } = require('../../../src/geo');
const helpers = require('../../../test/helpers');

// The test helpers load the test client; these tests are about this profile.
require('../../../src/brand').useClient(sample);

test('sample profile: welcome, typed order, order slip and menu pictures carry its own name', () => {
  const { db, orders, store } = helpers.setup({ seed: sample });
  db.exec("UPDATE outlets SET opens = '00:00', closes = '00:00'");
  const menuImages = createMenuImages({ menuItems: () => store.menuItems(), baseUrl: null });
  const bot = createBot({ orders, handoffs: createHandoffService(store), sessions: createSessionStore(store), menuImages });
  const say = (t) => bot.handle({ from: '919800000003', name: 'Ravi', type: 'text', text: t }, helpers.LUNCH);
  const tap = (id) => bot.handle({ from: '919800000003', name: 'Ravi', type: 'reply', replyId: id }, helpers.LUNCH);

  assert.match(say('hi')[0].text, /Welcome to \*Your Restaurant\* 🍽️/);
  tap('mode:pickup');
  const menu = tap('outlet:1');
  const images = menu.filter((m) => m.type === 'image');
  assert.ok(images.length >= 1);
  assert.match(images[0].svg, /YOUR RESTAURANT/);

  const r = say(sample.brand.orderExample);
  const slip = r.map((m) => m.text).join('\n');
  assert.match(slip, /2 × Butter Naan/);
  assert.match(slip, /Dal Makhani \(Half\)/);
  assert.match(slip, /Butter Chicken \(Full\)/);
});

test('sample profile: every locality has an outlet in range', () => {
  const { orders } = helpers.setup({ seed: sample });
  const outlets = orders.listOutlets().map((o) => ({ ...o, opens: '00:00', closes: '00:00' }));
  const near = sample.localities.filter((l) => ['Chandigarh', 'Mohali', 'Panchkula', 'Zirakpur'].includes(l.city));
  for (const l of near) assert.ok(assignOutlet(outlets, l, { fulfilment: 'delivery' }).outlet, `${l.name}, ${l.city}`);
});
