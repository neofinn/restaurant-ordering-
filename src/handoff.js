'use strict';

// Human handoff: when a customer asks for a person (or the bot can't follow a
// special request), the WhatsApp conversation is handed to outlet staff, who
// reply from the dashboard. While a handoff is open the bot stays quiet.

const { EventEmitter } = require('node:events');

function createHandoffService(store) {
  const events = new EventEmitter();
  const withMessages = (h) => (h ? { ...h, messages: store.handoffMessages(h.id) } : null);

  return {
    events,
    open({ phone, name, outletId, context }, now = new Date()) {
      const ts = now.toISOString();
      const id = store.openHandoff({ phone, name, outletId, ts });
      if (context) store.addHandoffMessage(id, 'bot', context, ts);
      const h = withMessages(store.handoff(id));
      events.emit('opened', h);
      return h;
    },
    openForPhone: (phone) => withMessages(store.openHandoffForPhone(phone)),
    get: (id) => withMessages(store.handoff(id)),
    addMessage(id, direction, body, now = new Date()) {
      store.addHandoffMessage(id, direction, String(body).slice(0, 2000), now.toISOString());
      const h = withMessages(store.handoff(id));
      events.emit('message', h, direction);
      return h;
    },
    close(id, now = new Date()) {
      const changed = store.closeHandoff(id, now.toISOString());
      if (changed) events.emit('closed', withMessages(store.handoff(id)));
      return changed;
    },
    list: ({ outletId, status = 'open' } = {}) => store.listHandoffs({ outletId, status }).map(withMessages),
  };
}

module.exports = { createHandoffService };
