'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { createReviews } = require('../src/reviews');
const { createBot, createSessionStore } = require('../src/whatsapp/bot');
const { toPayload } = require('../src/whatsapp/client');
const { computeAnalytics } = require('../src/analytics');
const { setup, LUNCH } = require('./helpers');

const itemId = (orders, name) => orders.menuFor(null).find((i) => i.name === name).id;

function world() {
  const ctx = setup();
  ctx.db.exec("UPDATE outlets SET opens = '00:00', closes = '00:00'");
  ctx.sent = [];
  ctx.reviews = createReviews({ store: ctx.store, orders: ctx.orders, client: { send: async (to, r) => { ctx.sent.push({ to, replies: r }); } }, log: { error() {} } });
  ctx.bot = createBot({ orders: ctx.orders, reviews: ctx.reviews, sessions: createSessionStore(ctx.store) });
  ctx.complete = (o) => { for (const s of ['accepted', 'preparing', 'ready', 'completed']) ctx.orders.updateStatus(o.code, s); };
  ctx.order = (extra = {}) => ctx.orders.createOrder({
    channel: 'whatsapp', fulfilment: 'pickup', outletId: 1, name: 'Aman', phone: '9876543210',
    items: [{ id: itemId(ctx.orders, 'Veg Hakka Noodles'), qty: 1 }, { id: itemId(ctx.orders, 'Veg Manchurian Gravy'), qty: 1 }], ...extra,
  }, LUNCH);
  return ctx;
}

const later = (min) => new Date(Date.now() + min * 60000);

test('asks for a review 30 minutes after completion, then each dish, then a comment', async () => {
  const w = world();
  const o = w.order();
  w.complete(o);
  await w.reviews.runDue(later(29));
  assert.equal(w.sent.length, 0, 'not before 30 minutes');
  await w.reviews.runDue(later(31));
  assert.equal(w.sent.length, 1);
  const ask = w.sent[0].replies[0];
  assert.equal(ask.type, 'list');
  assert.match(ask.text, new RegExp(`How was your order \\*${o.code}\\*`));
  assert.deepEqual(ask.sections[0].rows.map((r) => r.id), [5, 4, 3, 2, 1].map((n) => `rate:${o.code}:0:${n}`));
  for (const r of ask.sections[0].rows) assert.ok(r.title.length <= 24);
  toPayload('919876543210', ask);
  await w.reviews.runDue(later(60));
  assert.equal(w.sent.length, 1, 'asked once');

  const say = (m) => w.bot.handle({ from: '919876543210', ...m }, LUNCH);
  let r = say({ type: 'reply', replyId: `rate:${o.code}:0:4` });
  assert.match(r[1].text, /Dish 1 of 2: how was the \*Veg Hakka Noodles\*/);
  r = say({ type: 'reply', replyId: `rate:${o.code}:${itemId(w.orders, 'Veg Hakka Noodles')}:5` });
  assert.match(r[0].text, /Dish 2 of 2/);
  r = say({ type: 'reply', replyId: `rate:${o.code}:${itemId(w.orders, 'Veg Manchurian Gravy')}:3` });
  assert.match(r[0].text, /Anything else to tell the kitchen/);
  r = say({ type: 'text', text: 'Manchurian could be hotter' });
  assert.match(r[0].text, /Thank you for the feedback/);

  const a = computeAnalytics(w.store, { from: '2026-10-01', to: '2026-10-31' }, LUNCH);
  assert.equal(a.reviews.count, 1);
  assert.equal(a.reviews.average, 4);
  assert.equal(a.reviews.responseRate, 1);
  assert.deepEqual(a.reviews.byItem.map((i) => [i.name, i.average]).sort(), [['Veg Hakka Noodles', 5], ['Veg Manchurian Gravy', 3]]);
  assert.equal(a.reviews.comments[0].comment, 'Manchurian could be hotter');
  assert.equal(a.reviews.byOutlet.find((x) => x.outletId === 1).average, 4);
});

test('low rating offers a person; other numbers cannot rate; web orders use the template if set', async (t) => {
  const w = world();
  const o = w.order();
  w.complete(o);
  const say = (from, id) => w.bot.handle({ from, type: 'reply', replyId: id }, LUNCH);
  assert.match(say('919999999999', `rate:${o.code}:0:5`)[0].text, /not yours to review/);
  say('919876543210', `rate:${o.code}:0:1`);
  say('919876543210', `rate:${o.code}:${itemId(w.orders, 'Veg Hakka Noodles')}:2`);
  const r = say('919876543210', `rate:${o.code}:${itemId(w.orders, 'Veg Manchurian Gravy')}:1`);
  assert.match(r[0].text, /Sorry we let you down/);
  assert.ok(r[0].buttons.some((b) => b.id === 'act:human'));

  const web = w.order({ channel: 'web', phone: '9811100001' });
  w.complete(web);
  await w.reviews.runDue(later(31));
  assert.equal(w.sent.length, 0, 'already-rated order is not asked again; web needs a template');

  const prev = config.reviews.webTemplate;
  config.reviews.webTemplate = 'review_request';
  t.after(() => { config.reviews.webTemplate = prev; });
  const web2 = w.order({ channel: 'web', phone: '9811100002', name: 'Neha Gill' });
  w.complete(web2);
  await w.reviews.runDue(later(31));
  const tpl = w.sent.at(-1).replies[0];
  assert.equal(tpl.type, 'template');
  const p = toPayload('919811100002', tpl);
  assert.equal(p.template.name, 'review_request');
  assert.deepEqual(p.template.components[0].parameters.map((x) => x.text), ['Neha', web2.code]);
  assert.equal(p.template.components[1].parameters[0].payload, `review:${web2.code}`);
  // The template's button arrives as text "review:<code>" and starts the flow.
  const start = w.bot.handle({ from: '919811100002', type: 'text', text: `review:${web2.code}` }, LUNCH);
  assert.equal(start[0].type, 'list');
});
