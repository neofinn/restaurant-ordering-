'use strict';

// Razorpay Route: split a customer's payment to a restaurant's linked account.
// https://razorpay.com/docs/api/payments/route/
//  - transfer: part of a captured payment to a linked account, on hold
//    (POST /payments/:id/transfers). Held money stays with Razorpay under the
//    restaurant's name until released.
//  - release:  PATCH /transfers/:id { on_hold: false } settles it to the
//    restaurant's bank on Razorpay's next settlement cycle.
//  - reverse:  POST /transfers/:id/reversals { amount } takes (part of) it back
//    to the platform, e.g. commission owed on cash orders.
//  - account:  GET /v2/accounts/:id, the linked account's status.

class RouteError extends Error {}

function createRouteClient({ keyId, keySecret, baseUrl = 'https://api.razorpay.com', fetchImpl = fetch }) {
  const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
  const root = baseUrl.replace(/\/v1\/?$/, '');

  async function call(method, path, body) {
    const res = await fetchImpl(`${root}${path}`, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok) throw new RouteError(`Razorpay ${path}: ${res.status} ${json?.error?.description || text.slice(0, 200)}`);
    return json;
  }

  return {
    async transfer(paymentId, { account, amount, onHold = true, notes }) {
      const r = await call('POST', `/v1/payments/${encodeURIComponent(paymentId)}/transfers`, {
        transfers: [{ account, amount, currency: 'INR', on_hold: onHold, ...(notes ? { notes } : {}) }],
      });
      const t = r?.items?.[0] || r;
      if (!t?.id) throw new RouteError('Razorpay returned no transfer');
      return { id: t.id, amount: t.amount, onHold: Boolean(t.on_hold) };
    },
    async release(transferId) {
      const t = await call('PATCH', `/v1/transfers/${encodeURIComponent(transferId)}`, { on_hold: false });
      return { id: t.id, onHold: Boolean(t.on_hold) };
    },
    async reverse(transferId, amount) {
      const r = await call('POST', `/v1/transfers/${encodeURIComponent(transferId)}/reversals`, { amount });
      return { id: r.id, amount: r.amount };
    },
    async account(accountId) {
      const a = await call('GET', `/v2/accounts/${encodeURIComponent(accountId)}`);
      return { id: a.id, status: a.status, name: a.legal_business_name || a.customer_facing_business_name || null, email: a.email || null };
    },
  };
}

module.exports = { createRouteClient, RouteError };
