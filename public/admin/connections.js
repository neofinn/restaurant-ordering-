'use strict';

// Head office → Connections: payment gateways, UPI, WhatsApp and delivery
// partners. Keys entered here override the server's .env, are stored
// encrypted, apply at once, and are never shown again (only "set, ends …1a2b").
// The page also needs the owner's PIN (set on the server); the unlock lives
// only in this page's memory and ends after 10 idle minutes or "Lock now".
// Loaded after staff/panel.js and insights.js; registers its view on RCInsights.

(() => {
  const $ = (id) => document.getElementById(id);
  const S = { data: null, msg: {}, busy: '', dirty: new Set(), unlock: '', lockMsg: '', idleTimer: null, pinMsg: null, showPin: false };
  const call = (path, opts = {}) => window.RCAdmin.api(path, { ...opts, headers: { 'X-Owner-Unlock': S.unlock } })
    .catch((err) => { if (/^Locked/.test(err.message)) { S.unlock = ''; S.lockMsg = 'Locked again. Enter the owner PIN.'; } throw err; });
  // Lock in the browser too after 10 idle minutes (the server enforces it anyway).
  const touch = () => {
    clearTimeout(S.idleTimer);
    if (S.unlock) S.idleTimer = setTimeout(() => { S.unlock = ''; S.lockMsg = 'Locked after 10 minutes without use.'; S.dirty.clear(); if (window.RCAdmin.state.view === 'connections') window.RCAdmin.refresh(); }, 10 * 60000);
  };
  const when = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');
  const STATE = { on: ['ok', 'Connected'], test: ['test', 'Test mode'], warn: ['warn', 'Needs attention'], off: ['off', 'Off'] };

  function field(id, f) {
    const name = `f:${f.path}`;
    const src = f.source === 'panel' ? `<span class="src">set here${f.updatedAt ? ` · ${esc(when(f.updatedAt))}` : ''}</span>`
      : f.source === 'server' ? '<span class="src">from server settings (.env)</span>' : '';
    const clear = f.source === 'panel' ? `<button type="button" class="link" data-conn-clear="${id}" data-path="${esc(f.path)}" title="Remove the value saved here and use the server setting">use server setting</button>` : '';
    let input;
    if (f.type === 'select') {
      input = `<select name="${name}">${f.options.map(([v, l]) => `<option value="${esc(v)}" ${v === f.value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    } else if (f.type === 'secret') {
      input = `<input name="${name}" type="password" autocomplete="new-password" spellcheck="false" placeholder="${f.hint ? `${esc(f.hint)} · type to replace` : 'not set'}">`;
    } else {
      input = `<input name="${name}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}" spellcheck="false">`;
    }
    return `<label class="ofield"><span>${esc(f.label)} ${src} ${clear}</span>${input}${f.help ? `<small class="muted">${esc(f.help)}</small>` : ''}</label>`;
  }

  function card(c) {
    const [cls, word] = STATE[c.status.state] || STATE.off;
    const msg = S.msg[c.id];
    return `<section class="card conn" data-conn="${c.id}">
      <header><h3>${esc(c.title)}</h3><span class="chip conn-${cls}" title="${esc(word)}">${esc(c.status.text || word)}</span></header>
      <p class="small muted" style="margin-top:0">${esc(c.about)}</p>
      ${c.webhook ? `<div class="small webhook">Notifications address (paste into the ${esc(c.title.split(' ')[0])} dashboard):
        <code>${esc(c.webhook)}</code> <button type="button" class="link" data-copy="${esc(c.webhook)}">copy</button></div>` : ''}
      <form data-conn-form="${c.id}" autocomplete="off">
        <div class="conn-fields">${c.fields.map((f) => field(c.id, f)).join('')}</div>
        <div class="row" style="gap:8px;margin-top:8px">
          <button class="btn" style="width:auto" ${S.busy === c.id ? 'disabled' : ''}>Save</button>
          ${c.testable ? `<button type="button" class="btn secondary" style="width:auto" data-conn-test="${c.id}" ${S.busy === c.id ? 'disabled' : ''}>Test connection</button>` : ''}
        </div>
      </form>
      ${msg ? `<p class="small conn-msg ${msg.ok === false ? 'bad' : msg.ok ? 'good' : ''}" role="status">${esc(msg.text)}</p>` : ''}
    </section>`;
  }

  async function renderLock(ctx) {
    const st = await ctx.api('/owner/status');
    $('view').innerHTML = `<section class="card conn owner-lock" style="max-width:440px;margin:24px auto">
      <header><h3>🔒 Connections are locked</h3></header>
      <p class="small muted">Payment gateway, UPI, WhatsApp and delivery partner keys can only be changed with the <b>owner PIN</b>.</p>
      ${!st.hasPin ? '<p class="small bad">No owner PIN is set yet. The owner sets it on the server with <code>npm run owner-pin</code>.</p>'
        : st.lockedOutMinutes ? `<p class="small bad">Too many wrong PINs. Try again in ${st.lockedOutMinutes} min.</p>`
          : `<form id="ownerUnlock" autocomplete="off">
          <label class="ofield"><span>Owner PIN</span><input name="pin" type="password" inputmode="numeric" pattern="\\d{6,8}" minlength="6" maxlength="8" required autocomplete="off" aria-label="Owner PIN"></label>
          <button class="btn" style="margin-top:8px">Unlock</button>
        </form>`}
      ${S.lockMsg ? `<p class="small conn-msg bad" role="status">${esc(S.lockMsg)}</p>` : ''}
    </section>`;
    $('ownerUnlock')?.elements.pin.focus();
  }

  async function renderConnections(ctx) {
    // Don't wipe what someone is typing.
    if (S.dirty.size || document.activeElement?.closest?.('#view .conn form')) return;
    if (!S.unlock) return renderLock(ctx);
    try { S.data = await call('/connections'); } catch (err) { if (!S.unlock) return renderLock(ctx); throw err; }
    const groups = [...new Set(S.data.integrations.map((c) => c.group))];
    $('view').innerHTML = `
      <section class="card">
        <header><h3>Connections</h3><span class="small muted">Keys saved here are encrypted (${esc(S.data.encryption)}), apply immediately and are never shown again.</span></header>
        ${S.data.unreadable.length ? `<p class="small bad">Some saved keys can't be read (was SETTINGS_KEY changed?): ${S.data.unreadable.map(esc).join(', ')}. Enter them again.</p>` : ''}
        <p class="small muted" style="margin:0">Empty fields use the server's settings file. Fill one in to override it; "use server setting" removes the override.</p>
        <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center">
          <span class="chip conn-ok">🔓 Unlocked with the owner PIN · locks after 10 idle minutes</span>
          <button type="button" class="btn secondary" style="width:auto" data-owner-lock>Lock now</button>
          <button type="button" class="link" data-owner-pin-toggle>${S.showPin ? 'Hide' : 'Change owner PIN'}</button>
        </div>
        ${S.showPin ? `<form class="conn" id="ownerPin" autocomplete="off" style="max-width:420px;margin-top:10px">
          <label class="ofield"><span>Current PIN</span><input name="current" type="password" inputmode="numeric" required autocomplete="off"></label>
          <label class="ofield"><span>New PIN (6–8 digits)</span><input name="next" type="password" inputmode="numeric" required autocomplete="off"></label>
          <label class="ofield"><span>New PIN again</span><input name="again" type="password" inputmode="numeric" required autocomplete="off"></label>
          <button class="btn" style="width:auto;margin-top:8px">Change PIN</button>
        </form>` : ''}
        ${S.pinMsg ? `<p class="small conn-msg ${S.pinMsg.ok ? 'good' : 'bad'}" role="status">${esc(S.pinMsg.text)}</p>` : ''}
      </section>
      ${groups.map((g) => `<h3 class="section">${esc(g)}</h3><div class="conn-grid">${S.data.integrations.filter((c) => c.group === g).map(card).join('')}</div>`).join('')}
      <section class="card">
        <header><h3>Recent changes</h3></header>
        ${S.data.log.length ? `<ul class="small conn-log">${S.data.log.map((l) => `<li><b>${esc(when(l.at))}</b> · ${esc(l.integration)}: ${esc(l.change)}${l.by ? ` <span class="muted">(${esc(l.by)})</span>` : ''}</li>`).join('')}</ul>` : '<p class="small muted">No changes made here yet.</p>'}
      </section>`;
  }

  const refresh = () => { S.dirty.clear(); document.activeElement?.blur(); return window.RCAdmin.refresh(); };

  document.addEventListener('input', (e) => {
    const f = e.target.closest?.('[data-conn-form]');
    if (f) S.dirty.add(f.dataset.connForm);
  });

  document.addEventListener('submit', async (e) => {
    if (e.target.id === 'ownerUnlock') {
      e.preventDefault();
      const pin = e.target.elements.pin.value;
      try {
        const r = await window.RCAdmin.api('/owner/unlock', { method: 'POST', body: { pin } });
        S.unlock = r.token; S.lockMsg = ''; touch();
      } catch (err) { S.lockMsg = err.message; }
      e.target.elements.pin.value = '';
      return refresh();
    }
    if (e.target.id === 'ownerPin') {
      e.preventDefault();
      const f = e.target.elements;
      if (f.next.value !== f.again.value) { S.pinMsg = { ok: false, text: 'The new PINs don\'t match.' }; return refresh(); }
      try {
        await call('/owner/pin', { method: 'POST', body: { current: f.current.value, next: f.next.value } });
        // The new PIN signs everyone out, this page included.
        S.unlock = ''; S.showPin = false; S.pinMsg = null; S.lockMsg = 'Owner PIN changed. Unlock with the new PIN.';
      } catch (err) { S.pinMsg = { ok: false, text: err.message }; }
      return refresh();
    }
    const form = e.target.closest('[data-conn-form]');
    if (!form) return;
    touch();
    e.preventDefault();
    const id = form.dataset.connForm;
    const c = S.data.integrations.find((x) => x.id === id);
    const values = {};
    for (const f of c.fields) {
      const v = form.elements[`f:${f.path}`].value.trim();
      if (f.type === 'secret') { if (v) values[f.path] = v; continue; } // empty = keep
      if (v !== (f.value || '')) values[f.path] = v;
    }
    if (!Object.keys(values).length) { S.msg[id] = { text: 'Nothing changed.' }; return refresh(); }
    S.busy = id;
    try {
      await call(`/connections/${id}`, { method: 'PUT', body: { values } });
      S.msg[id] = { ok: true, text: c.testable ? 'Saved and in use. Use "Test connection" to check the keys.' : 'Saved and in use.' };
    } catch (err) { S.msg[id] = { ok: false, text: err.message }; }
    S.busy = '';
    refresh();
  });

  document.addEventListener('click', async (e) => {
    if (e.target.closest('[data-owner-lock]')) {
      await window.RCAdmin.api('/owner/lock', { method: 'POST', headers: { 'X-Owner-Unlock': S.unlock } }).catch(() => {});
      S.unlock = ''; S.lockMsg = ''; S.dirty.clear(); clearTimeout(S.idleTimer);
      return refresh();
    }
    if (e.target.closest('[data-owner-pin-toggle]')) { S.showPin = !S.showPin; S.pinMsg = null; return refresh(); }
    const t = e.target.closest('[data-conn-test]');
    if (t) touch();
    if (t) {
      const id = t.dataset.connTest;
      if (S.dirty.has(id)) { S.msg[id] = { ok: false, text: 'Save first, then test.' }; return refresh(); }
      S.busy = id; S.msg[id] = { text: 'Testing…' }; refresh();
      try {
        const r = await call(`/connections/${id}/test`, { method: 'POST' });
        S.msg[id] = { ok: r.ok, text: r.message };
      } catch (err) { S.msg[id] = { ok: false, text: err.message }; }
      S.busy = '';
      return refresh();
    }
    const clr = e.target.closest('[data-conn-clear]');
    if (clr) {
      const id = clr.dataset.connClear;
      if (!confirm('Remove the value saved here and use the server setting instead?')) return;
      try {
        await call(`/connections/${id}`, { method: 'PUT', body: { values: { [clr.dataset.path]: '' } } });
        S.msg[id] = { ok: true, text: 'Now using the server setting.' };
      } catch (err) { S.msg[id] = { ok: false, text: err.message }; }
      return refresh();
    }
    const cp = e.target.closest('[data-copy]');
    if (cp) {
      try { await navigator.clipboard.writeText(cp.dataset.copy); cp.textContent = 'copied'; } catch { prompt('Copy this address:', cp.dataset.copy); }
    }
  });

  Object.assign(window.RCInsights, {
    connections: () => renderConnections(window.RCAdmin),
  });
})();
