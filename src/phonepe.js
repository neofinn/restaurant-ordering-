'use strict';

// PhonePe Payment Gateway client (PG v1 "salt key" API): dynamic UPI QR,
// hosted pay page, status check, refunds and server-to-server callbacks.
//
// Requests: body { request: base64(JSON) }, header
//   X-VERIFY = sha256(base64 + apiPath + saltKey) + "###" + saltIndex
// Callbacks: body { response: base64(JSON) }, header
//   X-VERIFY = sha256(response + saltKey) + "###" + saltIndex
//
// Sandbox (shared test merchant from PhonePe's docs works without signing up):
//   https://api-preprod.phonepe.com/apis/pg-sandbox
// Production: https://api.phonepe.com/apis/hermes

const crypto = require('node:crypto');

const HOSTS = {
  sandbox: 'https://api-preprod.phonepe.com/apis/pg-sandbox',
  production: 'https://api.phonepe.com/apis/hermes',
};

class PhonePeError extends Error {}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
// merchantTransactionId: letters, digits, _ and -; at most 35 characters.
const txnId = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 35);

function createPhonePeClient({ merchantId, saltKey, saltIndex = '1', env = 'sandbox', baseUrl, callbackUrl, fetchImpl = fetch }) {
  const host = baseUrl || HOSTS[env] || HOSTS.sandbox;

  async function post(path, payload) {
    const b64 = Buffer.from(JSON.stringify(payload)).toString('base64');
    const res = await fetchImpl(host + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-VERIFY': `${sha256(b64 + path + saltKey)}###${saltIndex}` },
      body: JSON.stringify({ request: b64 }),
      signal: AbortSignal.timeout(10000),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.success) throw new PhonePeError(`PhonePe ${path}: ${res.status} ${json?.code || ''} ${json?.message || ''}`.trim());
    return json.data;
  }

  const pay = (reference, amount, phone, instrument, extra = {}) => post('/pg/v1/pay', {
    merchantId,
    merchantTransactionId: txnId(reference),
    merchantUserId: txnId(`U${String(phone || '').replace(/\D/g, '').slice(-10)}`) || 'GUEST',
    amount,
    callbackUrl,
    mobileNumber: String(phone || '').replace(/\D/g, '').slice(-10) || undefined,
    paymentInstrument: instrument,
    ...extra,
  });

  return {
    name: 'phonepe',
    /** Hosted pay page (UPI apps, QR, cards). Returns { id, url }. */
    async createLink({ reference, amount, customer, callbackUrl: redirectUrl }) {
      const d = await pay(reference, amount, customer.phone, { type: 'PAY_PAGE' }, { redirectUrl, redirectMode: 'REDIRECT' });
      return { id: txnId(reference), url: d.instrumentResponse.redirectInfo.url, status: 'created' };
    },

    /** Dynamic UPI QR for the exact amount. Returns { id, png: Buffer }. */
    async createQr({ reference, amount, customer }) {
      const d = await pay(reference, amount, customer.phone, { type: 'UPI_QR' });
      return { id: txnId(reference), png: Buffer.from(d.instrumentResponse.qrData, 'base64') };
    },

    /** { state: 'paid' | 'pending' | 'failed', paymentId, amount, utr } for one of our transactions. */
    async checkStatus(id) {
      const path = `/pg/v1/status/${merchantId}/${txnId(id)}`;
      const res = await fetchImpl(host + path, {
        headers: { 'X-VERIFY': `${sha256(path + saltKey)}###${saltIndex}`, 'X-MERCHANT-ID': merchantId },
        signal: AbortSignal.timeout(10000),
      });
      const json = await res.json().catch(() => null);
      if (!json) throw new PhonePeError(`PhonePe status: ${res.status}`);
      return toResult(json);
    },

    /** Refund a completed payment (by our transaction id). */
    async refund(paymentId, { linkId, amount, reason, refundId }) {
      const d = await post('/pg/v1/refund', {
        merchantId,
        merchantUserId: 'REFUND',
        originalTransactionId: txnId(linkId),
        merchantTransactionId: txnId(refundId || `R${linkId}`),
        amount,
        callbackUrl,
        ...(reason ? { message: reason.slice(0, 100) } : {}),
      });
      return { id: d.merchantTransactionId || txnId(refundId || `R${linkId}`), status: d.state };
    },
  };
}

// Status or callback payload -> our result.
function toResult(json) {
  const d = json.data || {};
  const state = d.state === 'COMPLETED' || json.code === 'PAYMENT_SUCCESS' ? 'paid'
    : (d.state === 'FAILED' || ['PAYMENT_ERROR', 'PAYMENT_DECLINED', 'TIMED_OUT'].includes(json.code)) ? 'failed' : 'pending';
  return { state, paymentId: d.transactionId || null, amount: Number(d.amount), utr: d.paymentInstrument?.utr || null, linkId: d.merchantTransactionId || null };
}

/** Is this callback signed with our salt key? body: { response }, header: X-VERIFY. */
function validPhonePeCallback(body, header, saltKey, saltIndex = '1') {
  if (!saltKey || !header || typeof body?.response !== 'string') return false;
  const expected = `${sha256(body.response + saltKey)}###${saltIndex}`;
  return header.length === expected.length && crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

/** Callback body -> { kind: 'paid' | 'ignored', code: null, linkId, paymentId, amount, eventId }. */
function parsePhonePeCallback(body) {
  let json;
  try { json = JSON.parse(Buffer.from(body.response, 'base64').toString('utf8')); } catch { return { kind: 'ignored' }; }
  const r = toResult(json);
  if (r.state !== 'paid') return { kind: 'ignored', state: r.state };
  // The order is found from our own record of the transaction (linkId), not guessed from it.
  return { kind: 'paid', code: null, linkId: r.linkId, paymentId: r.paymentId, amount: r.amount, eventId: `phonepe:${r.paymentId || r.linkId}` };
}

module.exports = { createPhonePeClient, validPhonePeCallback, parsePhonePeCallback, PhonePeError, HOSTS };
