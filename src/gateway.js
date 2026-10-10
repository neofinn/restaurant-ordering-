'use strict';

// Online payments through a gateway (Razorpay, PhonePe; see src/razorpay.js,
// src/phonepe.js). Every "Pay now" order gets a link on our own address,
// /pay/<code>; opening it creates (or reuses) the gateway's payment page for the
// exact amount and forwards the customer there: UPI apps, UPI QR, cards. Where
// the gateway makes dynamic UPI QR codes (PhonePe), /pay/<code>/qr.png is the
// gateway's own QR for this order; otherwise it is a QR of the pay link.
//
// The gateway's signed webhook confirms the payment: the order is marked paid
// and goes to the kitchen (orders.setPayment). No staff checking. As a safety
// net, sweep() asks the gateway about every open payment every 30 s, so a lost
// webhook can't leave an order stuck. If the outlet cancels a paid order, the
// payment is refunded automatically. A second payment for an order that is
// already paid is refunded too.
//
// A gateway client: { name, createLink, createQr?, checkStatus?, refund }.

const { EventEmitter } = require('node:events');

const MIN = 60000;
// Orders that can still be paid: waiting (or legacy placed-but-unpaid), not
// expired, cancelled or finished.
const PAYABLE_STATUSES = new Set(['awaiting_payment', 'placed', 'accepted', 'preparing', 'ready', 'out_for_delivery']);

function createGateway({ client, store, orders, publicBaseUrl, windowMinutes = 15, log = console }) {
  const events = new EventEmitter();
  const payable = (o) => o && o.payment_method === 'upi' && ['pending', 'claimed'].includes(o.payment_status) && PAYABLE_STATUSES.has(o.status);

  /**
   * The payment page URL for an order: a live link is reused, otherwise a new one
   * is made. Returns { url } or { done: 'paid' | 'closed' } when there is nothing to pay.
   */
  async function linkFor(code, now = new Date()) {
    const o = orders.getOrder(code);
    if (!o) return null;
    if (o.payment_status === 'paid' || o.payment_status === 'refunded') return { done: 'paid' };
    if (!payable(o)) return { done: 'closed' };
    const live = liveRow(o, 'link', now);
    if (live) return { url: live.url };
    const { args, expireBy } = request(o, 'link', now);
    const created = await client.createLink(args);
    store.insertPaymentLink({
      id: created.id, order_id: o.id, provider: client.name, kind: 'link', url: created.url, amount: o.total,
      expires_at: expireBy.toISOString(), status: 'created', created_at: now.toISOString(),
    });
    return { url: created.url };
  }

  const liveRow = (o, kind, now) => store.paymentLinks(o.id).find((l) => (l.kind || 'link') === kind && l.status === 'created'
    && l.amount === o.total && l.expires_at > new Date(now.getTime() + 2 * MIN).toISOString());

  // What to ask the gateway for. Each attempt has its own reference (gateways
  // want them unique): RCABC234-1 (pay page), RCABC234-Q1 (QR), …
  function request(o, kind, now) {
    const n = store.paymentLinks(o.id).filter((l) => (l.kind || 'link') === kind).length + 1;
    // Razorpay links must live at least 15 minutes; keep them a little past our payment window.
    const expireBy = new Date(now.getTime() + Math.max(16, windowMinutes + 5) * MIN);
    return {
      expireBy,
      args: {
        code: o.code,
        reference: kind === 'qr' ? `${o.code}-Q${n}` : (n > 1 ? `${o.code}-${n}` : o.code),
        amount: o.total,
        description: `Order ${o.code} · ${o.outlet.name}`,
        customer: { name: o.customer_name, phone: o.phone },
        expireBy,
        callbackUrl: `${publicBaseUrl}/track.html?code=${o.code}`,
      },
    };
  }

  /**
   * The gateway's own dynamic UPI QR (PNG) for an order, made on first use, or
   * null when the gateway doesn't make QR codes (then the QR is of the pay link).
   */
  const qrCache = new Map();
  async function qrFor(code, now = new Date()) {
    if (!client.createQr) return null;
    const o = orders.getOrder(code);
    if (!payable(o)) return null;
    const live = liveRow(o, 'qr', now);
    if (live && qrCache.has(live.id)) return qrCache.get(live.id);
    if (live && live.url.startsWith('data:image/png;base64,')) return Buffer.from(live.url.slice(22), 'base64');
    const { args, expireBy } = request(o, 'qr', now);
    const created = await client.createQr(args);
    store.insertPaymentLink({
      id: created.id, order_id: o.id, provider: client.name, kind: 'qr', url: `data:image/png;base64,${created.png.toString('base64')}`,
      amount: o.total, expires_at: expireBy.toISOString(), status: 'created', created_at: now.toISOString(),
    });
    qrCache.set(created.id, created.png);
    return created.png;
  }

  // Refund one payment. linkId: the link row to mark refunded (when it holds this payment).
  async function refund(order, paymentId, linkId, reason, now = new Date(), amount = order.total) {
    try {
      const r = await client.refund(paymentId, { linkId, amount, reason, refundId: `R${linkId}-${Date.now().toString(36)}` });
      if (linkId) store.updatePaymentLink(linkId, { status: 'refunded', refund_id: r.id }, now.toISOString());
      return r;
    } catch (e) {
      log.error(`[payments] refund of ${paymentId} for ${order.code} failed: ${e.message}`);
      events.emit('refund_failed', order, e);
      return null;
    }
  }

  /**
   * A verified webhook. eventId: X-Razorpay-Event-Id (duplicates are ignored).
   * Returns what happened: 'paid' | 'duplicate' | 'mismatch' | 'refunded_extra' | 'ignored' | 'unknown'.
   */
  async function handleWebhook(parsed, eventId, now = new Date()) {
    if (eventId && store.gatewayEventSeen(eventId, now.toISOString())) return 'duplicate';
    if (parsed.kind !== 'paid') return 'ignored';
    // The order comes from our own record of the payment request; the code the
    // gateway echoes back must agree when it sends one.
    const link = parsed.linkId ? store.paymentLinkById(parsed.linkId) : null;
    const o = link ? orders.getOrderById(link.order_id) : null;
    if (!o || (parsed.code && parsed.code !== o.code)) {
      log.error(`[payments] payment ${parsed.paymentId} for unknown order/link ${parsed.code}/${parsed.linkId}`);
      return 'unknown';
    }
    // The same payment reported twice (webhook and status check): nothing to do.
    if (parsed.paymentId && link.payment_id === parsed.paymentId) return 'duplicate';
    // Already paid (another link, or WhatsApp Pay): give this one back. The link
    // keeps the record of the payment that counts, if it holds one.
    if (o.payment_status === 'paid' || o.payment_status === 'refunded') {
      const ownRow = !link.payment_id;
      if (ownRow) store.updatePaymentLink(link.id, { status: 'paid', payment_id: parsed.paymentId }, now.toISOString());
      await refund(o, parsed.paymentId, ownRow ? link.id : null, `Duplicate payment for order ${o.code}`, now, parsed.amount);
      return 'refunded_extra';
    }
    store.updatePaymentLink(link.id, { status: 'paid', payment_id: parsed.paymentId }, now.toISOString());
    // The outlet cancelled before the money arrived.
    if (o.status === 'cancelled') {
      orders.setPayment(o.code, 'paid', now, 'gateway');
      await refundOrder(o.code, 'Order cancelled before payment arrived', now);
      return 'refunded_extra';
    }
    if (parsed.amount !== o.total) {
      // Never mark paid for the wrong amount; staff look at it.
      if (o.payment_status === 'pending') orders.setPayment(o.code, 'claimed', now, 'gateway');
      log.error(`[payments] ${o.code}: paid ${parsed.amount}, bill ${o.total}`);
      return 'mismatch';
    }
    orders.setPayment(o.code, 'paid', now, 'gateway');
    return 'paid';
  }

  // Refunds that failed (gateway busy, network) are tried again, backing off
  // from 30 s to 30 min, until they go through. Staff see "refund pending".
  const refundRetry = new Map(); // order code -> { tries, next (ms) }
  async function retryRefunds(now) {
    for (const code of store.refundsDue()) {
      const r = refundRetry.get(code) || { tries: 0, next: 0 };
      if (now.getTime() < r.next) continue;
      const ok = await refundOrder(code, `Order ${code} cancelled (refund retry)`, now).catch(() => false);
      if (ok) { refundRetry.delete(code); continue; }
      r.tries += 1;
      r.next = now.getTime() + Math.min(30 * MIN, 30000 * 2 ** (r.tries - 1));
      refundRetry.set(code, r);
      if (r.tries === 5) log.error(`[payments] refund for ${code} still failing after 5 tries; check the gateway dashboard`);
    }
  }

  /**
   * Ask the gateway about payment requests still open (lost webhooks, gateways
   * that only report by status check), and retry refunds that failed.
   * Returns how many orders it confirmed.
   */
  async function sweep(now = new Date()) {
    await retryRefunds(now);
    if (!client.checkStatus) return 0;
    const since = new Date(now.getTime() - (windowMinutes + 30) * MIN).toISOString();
    let confirmed = 0;
    for (const l of store.openPaymentLinks(since)) {
      let r;
      try { r = await client.checkStatus(l.id); } catch (e) { log.error(`[payments] status check ${l.id} failed: ${e.message}`); continue; }
      if (r.state === 'failed') store.updatePaymentLink(l.id, { status: 'failed' }, now.toISOString());
      if (r.state !== 'paid') continue;
      const result = await handleWebhook({ kind: 'paid', linkId: l.id, paymentId: r.paymentId, amount: r.amount }, `${client.name}:status:${r.paymentId || l.id}`, now);
      if (result === 'paid') confirmed += 1;
    }
    return confirmed;
  }
  let sweeper = null;

  /** Refund every captured gateway payment of an order (outlet cancelled it). */
  async function refundOrder(code, reason, now = new Date()) {
    const o = orders.getOrder(code);
    if (!o || o.payment_status !== 'paid') return false;
    const paid = store.paymentLinks(o.id).filter((l) => l.status === 'paid' && l.payment_id);
    if (!paid.length) return false;
    let ok = true;
    for (const l of paid) ok = Boolean(await refund(o, l.payment_id, l.id, reason, now)) && ok;
    if (ok) orders.setPayment(o.code, 'refunded', now, 'gateway');
    return ok;
  }

  // An outlet cancelling a paid order refunds the customer.
  const onStatus = (o) => {
    if (o.status !== 'cancelled' || o.payment_status !== 'paid') return;
    refundOrder(o.code, `Order ${o.code} cancelled by ${o.outlet.name}`).catch((e) => log.error('[payments] refund failed', e.message));
  };
  orders.events.on('status', onStatus);

  return {
    events, name: client.name, linkFor, qrFor, handleWebhook, refundOrder, sweep,
    startSweeper(ms = 30000) {
      if (!sweeper) { sweeper = setInterval(() => { sweep().catch((e) => log.error('[payments] sweep failed', e.message)); }, ms); sweeper.unref?.(); }
    },
    stopSweeper() { clearInterval(sweeper); sweeper = null; },
    /** Stop this gateway (settings changed): no more sweeps or refund listening. */
    close() { clearInterval(sweeper); sweeper = null; orders.events.off('status', onStatus); },
  };
}

module.exports = { createGateway };
