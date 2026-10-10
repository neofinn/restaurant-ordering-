'use strict';

// Razorpay client: payment links, refunds and webhook checks.
// API: https://razorpay.com/docs/api/payments/payment-links/create-standard
// Webhooks are signed with HMAC-SHA256 of the raw body (X-Razorpay-Signature)
// and carry a unique X-Razorpay-Event-Id.

const crypto = require('node:crypto');

class RazorpayError extends Error {}

function createRazorpayClient({ keyId, keySecret, baseUrl = 'https://api.razorpay.com/v1', fetchImpl = fetch }) {
  const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;

  async function call(method, path, body) {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok) throw new RazorpayError(`Razorpay ${path}: ${res.status} ${json?.error?.description || text.slice(0, 200)}`);
    return json;
  }

  return {
    name: 'razorpay',
    /**
     * A payment link for an order. reference must be unique per link (order
     * code, plus -2, -3… for a new attempt). expireBy: Date, at least 15 min ahead.
     */
    async createLink({ code, reference, amount, description, customer, expireBy, callbackUrl }) {
      const link = await call('POST', '/payment_links', {
        amount,
        currency: 'INR',
        accept_partial: false,
        reference_id: reference,
        description: description.slice(0, 2048),
        customer: { name: customer.name.slice(0, 80), contact: customer.phone },
        // We tell the customer ourselves (WhatsApp / web).
        notify: { sms: false, email: false },
        reminder_enable: false,
        notes: { order: code },
        expire_by: Math.floor(expireBy.getTime() / 1000),
        ...(callbackUrl ? { callback_url: callbackUrl, callback_method: 'get' } : {}),
      });
      return { id: link.id, url: link.short_url, status: link.status };
    },

    /** { state: 'paid' | 'pending' | 'failed', paymentId, amount } for one of our payment links. */
    async checkStatus(id) {
      const l = await call('GET', `/payment_links/${encodeURIComponent(id)}`);
      const p = (l.payments || []).find((x) => x.status === 'captured') || null;
      const state = l.status === 'paid' ? 'paid' : ['expired', 'cancelled'].includes(l.status) ? 'failed' : 'pending';
      return { state, paymentId: p?.payment_id || null, amount: Number(p?.amount ?? l.amount_paid) };
    },

    async cancelLink(id) {
      return call('POST', `/payment_links/${encodeURIComponent(id)}/cancel`);
    },

    /** Full refund (or `amount` paise) of a captured payment. */
    async refund(paymentId, { amount, reason } = {}) {
      const r = await call('POST', `/payments/${encodeURIComponent(paymentId)}/refund`, {
        ...(amount ? { amount } : {}), speed: 'normal', notes: reason ? { reason: reason.slice(0, 250) } : undefined,
      });
      return { id: r.id, status: r.status, amount: r.amount };
    },
  };
}

/** Is this webhook body signed with our secret? rawBody: the exact bytes received. */
function validRazorpaySignature(rawBody, signature, secret) {
  if (!secret || !signature || !rawBody) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

/**
 * Webhook body -> { kind: 'paid' | 'ignored', code, linkId, paymentId, amount, method }.
 * Only payment_link.paid moves money for us; everything else is acknowledged and ignored.
 */
function parseRazorpayWebhook(body) {
  if (body?.event !== 'payment_link.paid') return { kind: 'ignored', event: body?.event || null };
  const link = body.payload?.payment_link?.entity || {};
  const payment = body.payload?.payment?.entity || {};
  const code = link.notes?.order || String(link.reference_id || '').replace(/-\d+$/, '') || null;
  return { kind: 'paid', code, linkId: link.id || null, paymentId: payment.id || null, amount: Number(payment.amount ?? link.amount_paid), method: payment.method || null };
}

module.exports = { createRazorpayClient, validRazorpaySignature, parseRazorpayWebhook, RazorpayError };
