'use strict';

// Picks the delivery partner for an order. Every configured partner is asked
// for a quote at the same time (each with a short timeout); partners that
// can't serve the address, aren't set up for the outlet, or can't collect cash
// on an unpaid order drop out. The rest are ranked by an effective cost:
//
//   quoted price
//   + expected wait for a rider × the value of a minute (rush hour matters)
//   + a penalty for that partner's recent failure rate
//
// Expected wait: the partner's own estimate if it gives one, otherwise its
// average time to assign a rider over the last 7 days (from our deliveries
// table), otherwise a default. So a partner that is cheap but slow to find
// riders loses to one that costs ₹5 more but sends someone in 3 minutes.

const DAY = 86400000;

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not answer in time`)), ms); }),
  ]);
}

function createSelector({
  store,
  minuteValue = 300, // paise per minute of waiting for a rider (₹3)
  failurePenalty = 3000, // paise at a 100% failure rate (₹30)
  defaultAssignMin = 8,
  timeoutMs = 4000,
  historyDays = 7,
  now = () => new Date(),
} = {}) {
  function history() {
    const since = new Date(now().getTime() - historyDays * DAY).toISOString();
    return new Map(store.deliveryStats(since).map((s) => [s.provider, s]));
  }

  /**
   * Rank providers for an order. exclude: names already tried for it.
   * Returns { ranked: [{ provider, price, etaMin, score }], rejected: [{ name, label, reason }] }.
   */
  async function rank(order, outlet, providers, exclude = []) {
    const hist = history();
    const rejected = [];
    const candidates = providers.filter((p) => {
      if (exclude.includes(p.name)) { rejected.push({ name: p.name, label: p.label, reason: 'already tried for this order' }); return false; }
      if (p.ready && !p.ready(outlet)) { rejected.push({ name: p.name, label: p.label, reason: `${outlet.name} has no ${p.label || p.name} store code / account yet` }); return false; }
      if (order.payment_status !== 'paid' && p.supportsCod === false) { rejected.push({ name: p.name, label: p.label, reason: 'no cash on delivery' }); return false; }
      return true;
    });
    // A provider without quote() is always a candidate, at an unknown price.
    const quotes = await Promise.allSettled(candidates.map((p) => (p.quote ? withTimeout(p.quote(order, outlet), timeoutMs, p.label || p.name) : Promise.resolve({ ok: true, price: 0, etaMin: null }))));
    const ranked = [];
    quotes.forEach((q, i) => {
      const p = candidates[i];
      if (q.status === 'rejected') { rejected.push({ name: p.name, label: p.label, reason: q.reason.message }); return; }
      if (!q.value.ok) { rejected.push({ name: p.name, label: p.label, reason: q.value.reason || 'not serviceable' }); return; }
      const h = hist.get(p.name);
      const etaMin = q.value.etaMin ?? (h?.assign_min != null ? Math.round(h.assign_min * 10) / 10 : defaultAssignMin);
      const failRate = h && h.booked >= 5 ? h.failed / h.booked : 0;
      const score = Math.round(q.value.price + etaMin * minuteValue + failRate * failurePenalty);
      ranked.push({ provider: p, price: q.value.price, etaMin, failRate, score });
    });
    ranked.sort((a, b) => a.score - b.score || a.price - b.price);
    return { ranked, rejected };
  }

  return { rank };
}

module.exports = { createSelector };
