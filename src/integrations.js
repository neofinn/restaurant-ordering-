'use strict';

// Head office → Connections: the third-party services the system talks to
// (payment gateways, UPI, WhatsApp, delivery partners), set up from the panel
// instead of only in the server's .env file.
//
// - A value saved in the panel overrides .env; clearing it falls back to .env.
// - Secrets (keys, tokens) are encrypted in the database with AES-256-GCM using
//   SETTINGS_KEY, and never sent back to the browser (only "set, ends …1a2b").
// - Saving applies at once: the payment gateway and delivery partners are
//   rebuilt, WhatsApp reads its keys at send time. No restart.
// - "Test" makes a harmless call to the service with the saved keys.
// - Every change is logged (who, when, which fields; never the values).

const crypto = require('node:crypto');
const config = require('./config');
const { ValidationError } = require('./orders');

const UPI_ID = /^[\w.-]{2,256}@[a-zA-Z][a-zA-Z0-9.-]{1,64}$/;

// type: text | secret | select. path: where it lives in config.
const DEFS = [
  {
    id: 'payments', group: 'Payments', title: 'Payment gateway in use',
    about: 'Which gateway takes "Pay now" payments. Without one, customers get a UPI QR to your UPI ID and staff confirm payments by hand.',
    fields: [{ path: 'payments.provider', label: 'Use', type: 'select', options: [['auto', 'Automatic (whichever has keys)'], ['none', 'None: UPI QR, staff confirm'], ['razorpay', 'Razorpay'], ['phonepe', 'PhonePe']] }],
  },
  {
    id: 'upi', group: 'Payments', title: 'UPI QR (without a gateway)',
    about: 'The UPI ID every order\'s QR pays to, with the exact amount and order code filled in. An outlet\'s own UPI ID (Outlets tab) overrides it.',
    fields: [
      { path: 'upi.id', label: 'UPI ID', type: 'text', placeholder: 'yourbusiness@okhdfcbank', check: (v) => UPI_ID.test(v) || 'Doesn\'t look like a UPI ID (name@bank).' },
      { path: 'upi.payeeName', label: 'Name shown in UPI apps', type: 'text' },
      { path: 'upi.merchantCode', label: 'Merchant code', type: 'text', placeholder: '5812', help: '5812 for restaurants (merchant UPI IDs). Empty for a personal UPI ID.', check: (v) => /^\d{4}$/.test(v) || 'Four digits, e.g. 5812.' },
    ],
  },
  {
    id: 'razorpay', group: 'Payments', title: 'Razorpay', webhook: '/webhooks/razorpay',
    about: 'Payment links (UPI apps, QR, cards). Webhook event: payment_link.paid. Test keys start rzp_test_.',
    fields: [
      { path: 'razorpay.keyId', label: 'Key ID', type: 'text', placeholder: 'rzp_live_… or rzp_test_…', check: (v) => /^rzp_(live|test)_\w+$/.test(v) || 'Key IDs start rzp_live_ or rzp_test_.' },
      { path: 'razorpay.keySecret', label: 'Key secret', type: 'secret' },
      { path: 'razorpay.webhookSecret', label: 'Webhook secret', type: 'secret', help: 'The secret you typed when adding the webhook in the Razorpay dashboard.' },
    ],
  },
  {
    id: 'phonepe', group: 'Payments', title: 'PhonePe Payment Gateway', webhook: '/webhooks/phonepe',
    about: 'Dynamic UPI QR per order and a pay page. Sandbox works with PhonePe\'s shared test merchant PGTESTPAYUAT86.',
    fields: [
      { path: 'phonepe.merchantId', label: 'Merchant ID', type: 'text' },
      { path: 'phonepe.saltKey', label: 'Salt key', type: 'secret' },
      { path: 'phonepe.saltIndex', label: 'Salt index', type: 'text', placeholder: '1', check: (v) => /^\d{1,3}$/.test(v) || 'A number, usually 1.' },
      { path: 'phonepe.env', label: 'Environment', type: 'select', options: [['sandbox', 'Sandbox (test, no real money)'], ['production', 'Production']] },
    ],
  },
  {
    id: 'whatsapp', group: 'Messaging', title: 'WhatsApp Business (Meta Cloud API)', webhook: '/webhooks/whatsapp',
    about: 'Ordering on WhatsApp. From developers.facebook.com → your app → WhatsApp → API setup. Enter the verify token in Meta\'s webhook settings too.',
    fields: [
      { path: 'whatsapp.token', label: 'Permanent access token', type: 'secret' },
      { path: 'whatsapp.phoneNumberId', label: 'Phone number ID', type: 'text', check: (v) => /^\d{6,20}$/.test(v) || 'Digits only (the ID, not the phone number).' },
      { path: 'whatsapp.appSecret', label: 'App secret', type: 'secret', help: 'Checks that webhook messages really come from Meta.' },
      { path: 'whatsapp.verifyToken', label: 'Webhook verify token', type: 'secret' },
      { path: 'whatsapp.payments', label: 'Payments inside WhatsApp', type: 'select', options: [['off', 'Off'], ['on', 'On ("Review and pay")']], bool: true },
    ],
  },
  {
    id: 'shadowfax', group: 'Delivery partners', title: 'Shadowfax', webhook: '/webhooks/shadowfax',
    about: 'Hyperlocal riders. Each outlet also needs its Shadowfax store code (Outlets tab).',
    fields: [
      { path: 'shadowfax.mode', label: 'Use', type: 'select', options: [['off', 'Off'], ['live', 'On'], ['simulate', 'Simulated (testing only)']] },
      { path: 'shadowfax.token', label: 'API token', type: 'secret' },
      { path: 'shadowfax.baseUrl', label: 'API address', type: 'text', placeholder: 'https://api.shadowfax.in', check: (v) => /^https:\/\//.test(v) || 'Must start with https://' },
      { path: 'shadowfax.callbackToken', label: 'Callback secret', type: 'secret', help: 'Shadowfax sends it in the X-Callback-Token header.' },
    ],
  },
  {
    id: 'porter', group: 'Delivery partners', title: 'Porter', webhook: '/webhooks/porter',
    about: 'Two-wheelers, prepaid orders only.',
    fields: [
      { path: 'porter.apiKey', label: 'API key', type: 'secret' },
      { path: 'porter.baseUrl', label: 'API address', type: 'text', check: (v) => /^https:\/\//.test(v) || 'Must start with https://' },
      { path: 'porter.callbackToken', label: 'Callback secret', type: 'secret', help: 'Add ?token=<this> to the webhook address you give Porter.' },
    ],
  },
  {
    id: 'borzo', group: 'Delivery partners', title: 'Borzo', webhook: '/webhooks/borzo',
    about: 'Motorbike couriers, cash on delivery supported.',
    fields: [
      { path: 'borzo.token', label: 'API token', type: 'secret' },
      { path: 'borzo.baseUrl', label: 'API address', type: 'text', check: (v) => /^https:\/\//.test(v) || 'Must start with https://' },
      { path: 'borzo.callbackSecret', label: 'Callback secret key', type: 'secret' },
    ],
  },
];

const get = (path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), config);
const set = (path, value) => {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], config)[last] = value;
};
const FIELDS = new Map(DEFS.flatMap((d) => d.fields.map((f) => [f.path, { ...f, integration: d.id }])));

// Stored form of a value <-> config form (booleans are stored as on/off).
const toConfig = (f, v) => (f.bool ? v === 'on' : v);
const fromConfig = (f, v) => (f.bool ? (v ? 'on' : 'off') : (v ?? ''));

// cipher: replaces encryption (the browser demo has no AES); liveTests: false in the demo.
function createIntegrations({ store, publicBaseUrl = () => config.publicBaseUrl, fetchImpl = (...a) => fetch(...a), onChange = () => {}, log = console, cipher = null, liveTests = true }) {
  // What .env says, kept so clearing a panel value falls back to it.
  const baseline = new Map([...FIELDS.keys()].map((p) => [p, get(p)]));

  // ---- Encryption -----------------------------------------------------------
  let keyCache = null;
  function key() {
    const source = config.settingsKey || `admin:${config.adminToken}`;
    if (keyCache?.source !== source) keyCache = { source, key: crypto.scryptSync(source, 'connections-v1', 32) };
    return keyCache.key;
  }
  function encrypt(text) {
    if (cipher) return cipher.encrypt(text);
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
    const body = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
    return `v1:${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')}`;
  }
  function decrypt(stored) {
    if (cipher) return cipher.decrypt(stored);
    const raw = Buffer.from(String(stored).replace(/^v1:/, ''), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  }

  // ---- Load / apply ---------------------------------------------------------
  let unreadable = [];
  function saved() {
    const out = new Map();
    unreadable = [];
    for (const row of store.allSettings()) {
      if (!FIELDS.has(row.key)) continue;
      try { out.set(row.key, { ...row, value: row.secret ? decrypt(row.value) : row.value }); } catch {
        unreadable.push(row.key);
        log.error(`[connections] can't decrypt ${row.key} (SETTINGS_KEY changed?); using the .env value`);
      }
    }
    return out;
  }

  /** Put panel values (or .env values) into the running config. */
  function apply() {
    const s = saved();
    for (const [path, f] of FIELDS) set(path, s.has(path) ? toConfig(f, s.get(path).value) : baseline.get(path));
  }

  // ---- Describe (for the panel; no secret values) -----------------------------
  const mask = (v) => (v ? `set${v.length > 4 ? `, ends …${v.slice(-4)}` : ''}` : '');

  function status(id) {
    const c = config;
    switch (id) {
      case 'payments': {
        const g = c.paymentGateway();
        return g ? { state: 'on', text: `Using ${g === 'razorpay' ? 'Razorpay' : 'PhonePe'}` } : { state: 'off', text: 'No gateway: UPI QR, staff confirm payments' };
      }
      case 'upi': return c.upi.id ? { state: 'on', text: c.upi.id } : { state: 'off', text: 'Not set (outlets\' own UPI IDs are used)' };
      case 'razorpay':
        if (!c.razorpay.keyId) return { state: 'off', text: 'Not set up' };
        if (!c.razorpay.keySecret || !c.razorpay.webhookSecret) return { state: 'warn', text: 'Keys incomplete' };
        return { state: /^rzp_test_/.test(c.razorpay.keyId) ? 'test' : 'on', text: /^rzp_test_/.test(c.razorpay.keyId) ? 'Test mode' : 'Live' };
      case 'phonepe':
        if (!c.phonepe.merchantId) return { state: 'off', text: 'Not set up' };
        if (!c.phonepe.saltKey) return { state: 'warn', text: 'Salt key missing' };
        return { state: c.phonepe.env === 'production' ? 'on' : 'test', text: c.phonepe.env === 'production' ? 'Live' : 'Sandbox' };
      case 'whatsapp':
        if (!c.whatsapp.token || !c.whatsapp.phoneNumberId) return { state: 'off', text: 'Not connected (messages are only logged)' };
        return c.whatsapp.appSecret ? { state: 'on', text: 'Connected' } : { state: 'warn', text: 'App secret missing' };
      case 'shadowfax':
        return c.shadowfax.mode === 'live' ? (c.shadowfax.token ? { state: 'on', text: 'On' } : { state: 'warn', text: 'Token missing' })
          : c.shadowfax.mode === 'simulate' ? { state: 'test', text: 'Simulated' } : { state: 'off', text: 'Off' };
      case 'porter': return c.porter.apiKey ? { state: 'on', text: 'On' } : { state: 'off', text: 'Off' };
      case 'borzo': return c.borzo.token ? { state: 'on', text: 'On' } : { state: 'off', text: 'Off' };
      default: return { state: 'off', text: '' };
    }
  }

  function describe() {
    const s = saved();
    return {
      encryption: cipher ? 'demo: not stored anywhere' : config.settingsKey ? 'SETTINGS_KEY' : 'admin token (set SETTINGS_KEY)',
      unreadable,
      integrations: DEFS.map((d) => ({
        id: d.id, group: d.group, title: d.title, about: d.about,
        webhook: d.webhook ? `${publicBaseUrl()}${d.webhook}` : null,
        status: status(d.id),
        testable: ['razorpay', 'phonepe', 'whatsapp', 'upi'].includes(d.id),
        fields: d.fields.map((f) => {
          const current = fromConfig(f, get(f.path));
          const row = s.get(f.path);
          const source = row ? 'panel' : (fromConfig(f, baseline.get(f.path)) !== '' ? 'server' : 'unset');
          return {
            path: f.path, label: f.label, type: f.type, options: f.options, placeholder: f.placeholder, help: f.help, source,
            ...(f.type === 'secret' ? { hint: mask(current) } : { value: current }),
            updatedAt: row?.updated_at || null, updatedBy: row?.updated_by || null,
          };
        }),
      })),
      log: store.settingsLog(20),
    };
  }

  // ---- Save -----------------------------------------------------------------
  /**
   * values: { path: value }. '' clears the panel value (back to .env). For a
   * secret, a missing key or null leaves it unchanged.
   */
  function save(id, values, by = 'head office', now = new Date()) {
    const def = DEFS.find((d) => d.id === id);
    if (!def) throw new ValidationError('Unknown connection.', 'unknown');
    const changes = [];
    const errors = [];
    const writes = [];
    for (const f of def.fields) {
      if (!(f.path in values) || values[f.path] == null) continue;
      const v = String(values[f.path]).trim();
      if (v === '') { writes.push(() => store.deleteSetting(f.path)); changes.push(`${f.label} cleared`); continue; }
      if (f.type === 'select' && !f.options.some(([o]) => o === v)) { errors.push(`${f.label}: choose one of the options.`); continue; }
      const bad = f.check?.(v);
      if (typeof bad === 'string') { errors.push(`${f.label}: ${bad}`); continue; }
      if (v.length > 4000) { errors.push(`${f.label}: too long.`); continue; }
      const secret = f.type === 'secret';
      writes.push(() => store.setSetting(f.path, secret ? encrypt(v) : v, secret, now.toISOString(), by));
      changes.push(secret ? `${f.label} changed` : `${f.label} = ${v}`);
    }
    if (errors.length) throw new ValidationError(errors.join(' '), 'invalid');
    if (!changes.length) return describe();
    writes.forEach((w) => w());
    store.addSettingsLog(now.toISOString(), by, id, changes.join('; '));
    apply();
    try { onChange(id); } catch (e) { log.error(`[connections] applying ${id} failed: ${e.message}`); }
    return describe();
  }

  // ---- Test -----------------------------------------------------------------
  async function call(url, init) {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10000) });
    return { status: res.status, text: await res.text().catch(() => '') };
  }

  /** A harmless call with the saved keys. { ok: true|false, message }. */
  async function test(id) {
    const c = config;
    if (!liveTests) return { ok: null, message: 'Connection tests run on the real server. This demo isn\'t connected to anything.' };
    try {
      if (id === 'upi') {
        return c.upi.id && UPI_ID.test(c.upi.id)
          ? { ok: true, message: `QR codes will pay ${c.upi.id}. Scan a test order's QR with GPay, PhonePe and Paytm to be sure.` }
          : { ok: false, message: 'Set a UPI ID first.' };
      }
      if (id === 'razorpay') {
        if (!c.razorpay.keyId || !c.razorpay.keySecret) return { ok: false, message: 'Enter the key ID and secret first.' };
        const r = await call(`${c.razorpay.baseUrl}/payment_links?count=1`, { headers: { Authorization: `Basic ${Buffer.from(`${c.razorpay.keyId}:${c.razorpay.keySecret}`).toString('base64')}` } });
        if (r.status === 200) return { ok: true, message: `Razorpay accepted the keys (${/^rzp_test_/.test(c.razorpay.keyId) ? 'test mode' : 'live'}).${c.razorpay.webhookSecret ? '' : ' Add the webhook secret so payments confirm themselves.'}` };
        if (r.status === 401) return { ok: false, message: 'Razorpay rejected the key ID or secret.' };
        return { ok: false, message: `Razorpay answered ${r.status}.` };
      }
      if (id === 'phonepe') {
        if (!c.phonepe.merchantId || !c.phonepe.saltKey) return { ok: false, message: 'Enter the merchant ID and salt key first.' };
        const { HOSTS } = require('./phonepe');
        const path = `/pg/v1/status/${c.phonepe.merchantId}/CONNTEST${Date.now()}`;
        const verify = `${crypto.createHash('sha256').update(path + c.phonepe.saltKey).digest('hex')}###${c.phonepe.saltIndex}`;
        const r = await call(`${HOSTS[c.phonepe.env] || HOSTS.sandbox}${path}`, { headers: { 'X-VERIFY': verify, 'X-MERCHANT-ID': c.phonepe.merchantId } });
        // Good keys: "no such transaction" (204/404). Bad salt: 401. Unknown merchant: KEY_NOT_CONFIGURED.
        if ([200, 204, 404].includes(r.status)) return { ok: true, message: `PhonePe accepted the keys (${c.phonepe.env}).` };
        if (/KEY_NOT_CONFIGURED/.test(r.text)) return { ok: false, message: `PhonePe doesn't know merchant ${c.phonepe.merchantId} in ${c.phonepe.env}.` };
        if (r.status === 401) return { ok: false, message: 'PhonePe rejected the salt key or salt index.' };
        return { ok: false, message: `PhonePe answered ${r.status}.` };
      }
      if (id === 'whatsapp') {
        if (!c.whatsapp.token || !c.whatsapp.phoneNumberId) return { ok: false, message: 'Enter the access token and phone number ID first.' };
        const r = await call(`https://graph.facebook.com/${c.whatsapp.graphVersion}/${c.whatsapp.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`, { headers: { Authorization: `Bearer ${c.whatsapp.token}` } });
        if (r.status === 200) {
          const j = JSON.parse(r.text);
          return { ok: true, message: `Connected: ${j.verified_name || 'number'} ${j.display_phone_number || ''}${j.quality_rating ? `, quality ${j.quality_rating}` : ''}.` };
        }
        return { ok: false, message: `Meta rejected it (${r.status}): ${(r.text.match(/"message":"([^"]+)/) || [])[1] || 'check the token and phone number ID'}.` };
      }
      return { ok: null, message: 'No live check for this partner. Book one test delivery after saving.' };
    } catch (e) {
      return { ok: false, message: `Couldn't reach the service: ${e.message}` };
    }
  }

  apply();
  return { describe, save, test, apply, defs: DEFS };
}

module.exports = { createIntegrations, DEFS };
