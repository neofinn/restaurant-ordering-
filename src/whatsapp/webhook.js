'use strict';

const crypto = require('node:crypto');
const express = require('express');
const config = require('../config');

/** Turn a Cloud API webhook body into normalised messages for the bot. */
function parseWebhook(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const names = new Map((v.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of v.messages || []) {
        const base = { id: m.id, from: m.from, name: names.get(m.from) || null };
        if (m.type === 'text') out.push({ ...base, type: 'text', text: m.text?.body || '' });
        else if (m.type === 'location') out.push({ ...base, type: 'location', location: { lat: m.location.latitude, lng: m.location.longitude } });
        else if (m.type === 'interactive' && m.interactive?.type === 'payment') {
          // Payment confirmation for a "Review and pay" order.
          const p = m.interactive.payment || {};
          out.push({
            ...base, type: 'payment', referenceId: p.reference_id, status: String(p.status || '').toLowerCase(),
            transactionId: p.transaction_id || null,
            amount: p.total_amount ? Math.round((p.total_amount.value * 100) / (p.total_amount.offset || 100)) : null,
          });
        } else if (m.type === 'interactive') {
          const id = m.interactive?.button_reply?.id || m.interactive?.list_reply?.id;
          out.push(id ? { ...base, type: 'reply', replyId: id } : { ...base, type: 'unsupported' });
        } else if (m.type === 'order') {
          // Cart sent from the WhatsApp Business catalog.
          out.push({
            ...base, type: 'catalog_order', text: m.order?.text || '',
            items: (m.order?.product_items || []).map((p) => ({ retailerId: p.product_retailer_id, qty: Number(p.quantity) || 1 })),
          });
        } else if (m.type === 'image') {
          out.push({ ...base, type: 'image', mediaId: m.image?.id, text: m.image?.caption || '' });
        } else if (m.type === 'button') out.push({ ...base, type: 'text', text: m.button?.payload || m.button?.text || '' });
        else out.push({ ...base, type: 'unsupported' });
      }
      // Payment status updates for "Review and pay" orders arrive as statuses.
      for (const st of v.statuses || []) {
        if (st.type !== 'payment' || !st.payment?.reference_id) continue;
        const from = st.from || st.recipient_id;
        out.push({
          id: `${st.id}:${st.status}`, from, name: names.get(from) || null, type: 'payment',
          referenceId: st.payment.reference_id, status: String(st.status || '').toLowerCase(),
          transactionId: st.payment.transaction?.id || null,
          amount: st.payment.amount ? Math.round((st.payment.amount.value * 100) / (st.payment.amount.offset || 100)) : null,
        });
      }
    }
  }
  return out;
}

function validSignature(rawBody, header, secret) {
  if (!secret) return true; // not configured (local dev)
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from('sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex'));
  const got = Buffer.from(header);
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

function createWebhookRouter({ db, bot, client, log = console }) {
  const router = express.Router();
  const markSeen = db.prepare('INSERT OR IGNORE INTO wa_processed (message_id, at) VALUES (?, ?)');

  // Meta's one-time verification handshake.
  router.get('/', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === config.whatsapp.verifyToken) {
      return res.status(200).send(req.query['hub.challenge']);
    }
    res.sendStatus(403);
  });

  router.post('/', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (!validSignature(raw, req.get('x-hub-signature-256'), config.whatsapp.appSecret)) return res.sendStatus(401);
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return res.sendStatus(400); }
    res.sendStatus(200); // acknowledge fast; Meta retries slow webhooks

    for (const msg of parseWebhook(body)) {
      // Meta may deliver the same message more than once.
      if (markSeen.run(msg.id, new Date().toISOString()).changes === 0) continue;
      try {
        await client.send(msg.from, bot.handle(msg));
      } catch (e) {
        log.error('[whatsapp] failed to handle message', e);
      }
    }
  });

  return router;
}

module.exports = { createWebhookRouter, parseWebhook, validSignature };
