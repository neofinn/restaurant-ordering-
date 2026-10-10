'use strict';

// Converts the bot's abstract replies into WhatsApp Cloud API payloads and
// sends them. Without credentials it only logs, so local dev works offline.

const config = require('../config');
const { orderDetailsPayload } = require('../payments');

function toPayload(to, r) {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
  switch (r.type) {
    case 'text':
      return { ...base, type: 'text', text: { body: r.text, preview_url: true } };
    case 'buttons':
      return {
        ...base, type: 'interactive',
        interactive: {
          type: 'button', body: { text: r.text },
          action: { buttons: r.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
        },
      };
    case 'list':
      return {
        ...base, type: 'interactive',
        interactive: { type: 'list', body: { text: r.text }, action: { button: r.button, sections: r.sections } },
      };
    case 'image':
      return { ...base, type: 'image', image: { link: r.url, ...(r.text ? { caption: r.text } : {}) } };
    case 'order_details':
      return { ...base, type: 'interactive', interactive: orderDetailsPayload(r) };
    case 'order_status':
      // Updates the order card shown with the "Review and pay" message.
      return {
        ...base, type: 'interactive',
        interactive: {
          type: 'order_status', body: { text: r.text },
          action: { name: 'review_order', parameters: { reference_id: r.referenceId, order: { status: r.status, ...(r.description ? { description: r.description } : {}) } } },
        },
      };
    case 'template':
      // Approved message template (needed to message outside the 24h window).
      return {
        ...base, type: 'template',
        template: {
          name: r.name, language: { code: r.language || 'en' },
          components: [
            ...(r.params?.length ? [{ type: 'body', parameters: r.params.map((p) => ({ type: 'text', text: String(p) })) }] : []),
            ...(r.buttonPayload ? [{ type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: r.buttonPayload }] }] : []),
          ],
        },
      };
    case 'location_request':
      return {
        ...base, type: 'interactive',
        interactive: { type: 'location_request_message', body: { text: r.text }, action: { name: 'send_location' } },
      };
    default:
      throw new Error(`Unknown reply type ${r.type}`);
  }
}

// token / phoneNumberId: fixed values (tests), or left out to use the current
// settings at send time, so a change in Head office → Connections applies at once.
function createClient({ token, phoneNumberId, fetchImpl = globalThis.fetch, log = console } = {}) {
  const creds = () => ({ token: token ?? config.whatsapp.token, phoneNumberId: phoneNumberId ?? config.whatsapp.phoneNumberId });

  async function send(to, replies) {
    const c = creds();
    const enabled = Boolean(c.token && c.phoneNumberId);
    const url = `https://graph.facebook.com/${config.whatsapp.graphVersion}/${c.phoneNumberId}/messages`;
    for (const r of replies) {
      const payload = toPayload(to, r);
      if (!enabled) {
        log.info(`[whatsapp:dry-run] -> ${to}: ${r.text}`);
        continue;
      }
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        log.error(`[whatsapp] send failed ${res.status}: ${await res.text()}`);
        break; // keep message order: don't send later parts if an earlier one failed
      }
    }
  }

  return {
    get enabled() { const c = creds(); return Boolean(c.token && c.phoneNumberId); },
    send,
  };
}

module.exports = { createClient, toPayload };
