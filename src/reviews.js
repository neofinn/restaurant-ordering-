'use strict';

// Reviews: 30 minutes after an order is delivered (or picked up), ask the
// customer on WhatsApp to rate the order and then each dish, 1–5 stars, plus
// an optional comment. Ratings feed the analytics (by dish, outlet and dish
// combination). The delay survives restarts: it is a scheduled job in the
// database, run by a once-a-minute ticker.

const { EventEmitter } = require('node:events');
const config = require('./config');

const STARS = [
  [5, '⭐⭐⭐⭐⭐ Excellent'],
  [4, '⭐⭐⭐⭐ Good'],
  [3, '⭐⭐⭐ Okay'],
  [2, '⭐⭐ Poor'],
  [1, '⭐ Very bad'],
];
const MAX_DISHES = 6; // keep it quick

function createReviews({ store, orders, client, log = console }) {
  const events = new EventEmitter();
  const outletName = (o) => o.outlet?.name || '';
  const starRows = (code, itemId) => STARS.map(([n, title]) => ({ id: `rate:${code}:${itemId}:${n}`, title }));

  function dishesOf(o) {
    const seen = new Map();
    for (const l of o.items) if (!seen.has(l.item_id)) seen.set(l.item_id, l.name);
    return [...seen].slice(0, MAX_DISHES).map(([id, name]) => ({ id, name }));
  }

  function overallAsk(o) {
    return [{
      type: 'list',
      text: `⭐ How was your order *${o.code}* from ${outletName(o)}?\nTap to rate. It takes 20 seconds and helps our kitchen.`,
      button: 'Rate your order',
      sections: [{ title: 'Your rating', rows: starRows(o.code, 0) }],
    }];
  }

  function dishAsk(o, dish, n, total) {
    return [{
      type: 'list',
      text: `🍜 Dish ${n} of ${total}: how was the *${dish.name}*?`,
      button: 'Rate this dish',
      sections: [{ title: 'Your rating', rows: starRows(o.code, dish.id) }],
    }];
  }

  // Schedule the ask when an order completes.
  orders.events.on('status', (o) => {
    if (o.status !== 'completed') return;
    const runAt = new Date(Date.now() + config.reviews.delayMinutes * 60000).toISOString();
    store.addJob(runAt, 'review_request', { code: o.code });
  });

  /** Send the review request for an order (job handler). */
  async function request(code) {
    const o = orders.getOrder(code);
    if (!o || o.status !== 'completed' || store.ratingsForOrder(o.id).some((r) => r.item_id === 0)) return false;
    const to = o.phone.replace(/^\+/, '');
    if (o.channel === 'whatsapp') {
      await client.send(to, overallAsk(o));
      return true;
    }
    // Web orders need an approved template to open the chat; its quick-reply
    // button payload "review:<code>" starts the rating flow.
    if (config.reviews.webTemplate) {
      await client.send(to, [{ type: 'template', name: config.reviews.webTemplate, language: config.reviews.templateLanguage, params: [o.customer_name.split(' ')[0], o.code], buttonPayload: `review:${o.code}` }]);
      return true;
    }
    return false;
  }

  /** Run jobs that are due. */
  async function runDue(now = new Date()) {
    for (const job of store.dueJobs(now.toISOString())) {
      if (!store.markJobDone(job.id, now.toISOString())) continue;
      try {
        if (job.kind === 'review_request') await request(job.payload.code);
      } catch (e) {
        log.error('[reviews] job failed', e);
      }
    }
  }

  let timer = null;
  function startTicker(intervalMs = 60000) {
    if (timer) return;
    timer = setInterval(() => runDue().catch((e) => log.error('[reviews] tick failed', e)), intervalMs);
    timer.unref?.();
  }
  function stopTicker() { clearInterval(timer); timer = null; }

  const ownOrder = (code, phone) => {
    const o = orders.getOrder(code);
    if (!o || o.status !== 'completed') return null;
    return !phone || o.phone.replace(/\D/g, '') === String(phone).replace(/\D/g, '') ? o : null;
  };

  /** Start (or restart) the rating flow, e.g. from a template button. */
  function start(code, phone) {
    const o = ownOrder(code, phone);
    return o ? overallAsk(o) : null;
  }

  /**
   * Save one rating. Returns { replies, askComment, low } with the next
   * question (next dish) or, after the last dish, the comment prompt.
   */
  function rate(code, itemId, stars, phone, now = new Date()) {
    const o = ownOrder(code, phone);
    const n = Math.round(Number(stars));
    if (!o || n < 1 || n > 5) return null;
    const dishes = dishesOf(o);
    const id = Number(itemId);
    const dish = dishes.find((d) => d.id === id);
    if (id !== 0 && !dish) return null;
    store.addRating({ orderId: o.id, itemId: id, name: id === 0 ? 'Whole order' : dish.name, stars: n, outletId: o.outlet_id, phone: o.phone, at: now.toISOString() });
    events.emit('rating', { order: o, itemId: id, stars: n });

    const rated = new Set(store.ratingsForOrder(o.id).map((r) => r.item_id));
    const next = dishes.findIndex((d) => !rated.has(d.id));
    if (next >= 0) {
      const thanks = id === 0 ? { type: 'text', text: n >= 4 ? '🙏 Thank you! Now a quick rating for each dish:' : '🙏 Thanks for telling us. Which dishes let you down?' } : null;
      return { replies: [...(thanks ? [thanks] : []), ...dishAsk(o, dishes[next], next + 1, dishes.length)], askComment: false };
    }
    const overall = store.ratingsForOrder(o.id).find((r) => r.item_id === 0)?.stars ?? n;
    return {
      askComment: true,
      low: overall <= 2,
      replies: [{
        type: 'buttons',
        text: overall <= 2
          ? '😔 Sorry we let you down. What went wrong? Type it here and the outlet manager will see it. Or talk to our team now.'
          : '✍️ Anything else to tell the kitchen? Type a message, or tap Skip.',
        buttons: overall <= 2
          ? [{ id: `rev_skip:${o.code}`, title: 'Skip' }, { id: 'act:human', title: '💬 Talk to us' }]
          : [{ id: `rev_skip:${o.code}`, title: 'Skip' }],
      }],
    };
  }

  function comment(code, text, phone, now = new Date()) {
    const o = ownOrder(code, phone);
    if (!o) return false;
    store.addReviewComment(o.id, String(text).trim().slice(0, 500), now.toISOString());
    events.emit('comment', { order: o, text });
    return true;
  }

  const thanks = () => [{ type: 'text', text: '🙏 Thank you for the feedback! Type *hi* whenever you are hungry again. ⭐ Type *points* to see your loyalty points.' }];

  return { events, request, runDue, startTicker, stopTicker, start, rate, comment, thanks, STARS };
}

module.exports = { createReviews };
