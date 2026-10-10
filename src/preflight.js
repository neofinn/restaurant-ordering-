'use strict';

// Go-live checks. In production the server refuses to start on an error (a
// setting that would be unsafe or plainly wrong) and logs warnings for things
// still left as placeholders. `npm run check` prints the same report without
// starting anything.

const STAGING = {
  shadowfax: /staging/i,
  porter: /uat/i,
  borzo: /robotapitest/i,
};

/**
 * config: src/config.js; store: the data store (for outlets and PINs).
 * Returns { errors: [...], warnings: [...], ok: [...] }, each a line of text.
 */
function preflight(config, store) {
  const errors = [];
  const warnings = [];
  const ok = [];
  const prod = config.production;
  const need = prod ? errors : warnings;

  // ---- Settings ------------------------------------------------------------
  if (!prod) warnings.push('NODE_ENV is not "production" (the WhatsApp simulator and dev tools are on).');

  if (!config.adminToken || config.adminToken === 'change-me') need.push('ADMIN_TOKEN is not set.');
  else if (config.adminToken.length < 24) need.push('ADMIN_TOKEN is shorter than 24 characters; generate one with: openssl rand -hex 24');
  else ok.push('Head office token set.');

  if (!config.settingsKey) warnings.push('SETTINGS_KEY is not set: keys saved in Head office → Connections are encrypted with the admin token instead (changing it would lose them). setup.sh sets one.');

  if (!/^https:\/\//.test(config.publicBaseUrl)) need.push(`PUBLIC_BASE_URL must be the https:// address customers use (now ${config.publicBaseUrl}).`);
  else ok.push(`Public address ${config.publicBaseUrl}.`);

  const wa = config.whatsapp;
  if (!wa.token || !wa.phoneNumberId) {
    warnings.push('WhatsApp is not connected (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID): the bot only logs what it would send.');
  } else {
    if (!wa.appSecret) need.push('WHATSAPP_APP_SECRET is not set: anyone could post fake WhatsApp messages to the webhook.');
    if (!wa.verifyToken || wa.verifyToken === 'whatsapp-verify') need.push('WHATSAPP_VERIFY_TOKEN is the default; set your own and enter it in Meta\'s webhook settings.');
    if (wa.appSecret && wa.verifyToken !== 'whatsapp-verify') ok.push('WhatsApp connected, webhook signatures checked.');
  }

  // ---- Delivery partners ---------------------------------------------------
  const sfx = config.shadowfax;
  if (sfx.mode === 'simulate') need.push('SHADOWFAX_MODE=simulate: deliveries go to pretend partners, no real rider will come.');
  const partners = [];
  if (sfx.mode === 'live') {
    partners.push('Shadowfax');
    if (STAGING.shadowfax.test(sfx.baseUrl)) warnings.push(`Shadowfax points at its test server (${sfx.baseUrl}); set SHADOWFAX_BASE_URL to the live one from Shadowfax.`);
    if (!sfx.callbackToken) need.push('SHADOWFAX_CALLBACK_TOKEN is not set: rider updates from Shadowfax can\'t be checked.');
  }
  if (config.porter.apiKey) {
    partners.push('Porter');
    if (STAGING.porter.test(config.porter.baseUrl)) warnings.push(`Porter points at its test server (${config.porter.baseUrl}); set PORTER_BASE_URL to the live one.`);
    if (!config.porter.callbackToken) need.push('PORTER_CALLBACK_TOKEN is not set: rider updates from Porter can\'t be checked.');
  }
  if (config.borzo.token) {
    partners.push('Borzo');
    if (STAGING.borzo.test(config.borzo.baseUrl)) warnings.push(`Borzo points at its test server (${config.borzo.baseUrl}); set BORZO_BASE_URL to the live one (robot-in.borzodelivery.com in Borzo's docs).`);
    if (!config.borzo.callbackSecret) need.push('BORZO_CALLBACK_SECRET is not set: rider updates from Borzo can\'t be checked.');
  }
  if (sfx.mode !== 'simulate') {
    if (partners.length) ok.push(`Delivery partners: ${partners.join(', ')}.`);
    else warnings.push('No delivery partner is connected: outlets deliver with their own riders.');
  }
  const d = config.delivery;
  if (d.baseFee === 4000 && d.perKmFee === 1000 && d.baseKm === 3) {
    warnings.push('Delivery charge is still the placeholder rate card (₹40 for 3 km + ₹10/km); set DELIVERY_BASE_FEE_PAISE, DELIVERY_BASE_KM and DELIVERY_PER_KM_PAISE to the contract rates.');
  }

  // ---- Online payments -----------------------------------------------------
  const rp = config.razorpay || {};
  if (rp.keyId && config.phonepe?.merchantId) warnings.push('Both Razorpay and PhonePe keys are set; Razorpay is used. Remove one.');
  if (rp.keyId) {
    if (!rp.keySecret) need.push('RAZORPAY_KEY_SECRET is not set: payment links can\'t be created.');
    if (!rp.webhookSecret) need.push('RAZORPAY_WEBHOOK_SECRET is not set: payments can\'t be confirmed automatically.');
    if (/^rzp_test_/.test(rp.keyId)) (prod ? warnings : ok).push('Razorpay is in test mode (rzp_test_ key): no real money moves. Use the live key to take payments.');
    else if (rp.keySecret && rp.webhookSecret) ok.push('Razorpay connected: online payments confirm themselves; cancelled paid orders are refunded.');
  } else if (config.phonepe?.merchantId) {
    const pp = config.phonepe;
    if (!pp.saltKey) need.push('PHONEPE_SALT_KEY is not set: payments can\'t be created or callbacks checked.');
    if (pp.env !== 'production') (prod ? warnings : ok).push('PhonePe is in sandbox (PHONEPE_ENV is not "production"): no real money moves.');
    else if (pp.saltKey) ok.push('PhonePe connected: dynamic UPI QR per order, payments confirm themselves (callback + status check every 30 s).');
  } else {
    warnings.push('No payment gateway: "Pay now" goes straight to each outlet\'s UPI ID and staff confirm every payment by hand. Set RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET for automatic confirmation.');
  }

  if (!config.supabase.url) warnings.push('Supabase copy is off (optional; gives an off-server copy of the data).');
  else ok.push('Supabase copy on.');

  // ---- Outlet data ---------------------------------------------------------
  if (store) {
    const outlets = store.outlets().filter((o) => o.active);
    // Where each outlet's UPI money would go (business-wide UPI_ID or the outlet's own).
    const { upiFor } = require('./payments');
    const placeholderUpi = outlets.filter((o) => /@example$/.test(upiFor(o)?.id || ''));
    const noUpi = outlets.filter((o) => !upiFor(o));
    const fakePhone = outlets.filter((o) => /^\+?910{6,}/.test(o.phone || ''));
    const withPin = new Set(store.outletLogins().map((l) => l.outlet_id));
    const noPin = outlets.filter((o) => !withPin.has(o.id));
    const noSfx = sfx.mode === 'live' ? outlets.filter((o) => !o.sfx_store_code) : [];
    const names = (list) => list.map((o) => o.name).join(', ');
    if (placeholderUpi.length && !config.paymentGateway?.()) warnings.push(`Placeholder UPI IDs (…@example) at: ${names(placeholderUpi)}. The payment QR can't be paid; set UPI_ID (your payment gateway's merchant UPI ID, used by every outlet) or each outlet's UPI ID in Head office → Outlets.`);
    if (noUpi.length && !config.paymentGateway?.()) warnings.push(`No UPI ID (pay on delivery only) at: ${names(noUpi)}.`);
    if (fakePhone.length) warnings.push(`Placeholder phone numbers at: ${names(fakePhone)}.`);
    if (noPin.length) warnings.push(`No outlet panel PIN yet for: ${names(noPin)} (set in Head office → Outlets).`);
    if (noSfx.length) warnings.push(`No Shadowfax store code for: ${names(noSfx)}.`);
    ok.push(`${outlets.length} outlets active.`);
    if (!store.allSettings().some((r) => r.key === 'owner.pinHash')) warnings.push('No owner PIN yet: Head office → Connections can\'t be opened. Set one on the server: npm run owner-pin');
  }

  return { errors, warnings, ok };
}

function format({ errors, warnings, ok }) {
  return [
    ...errors.map((t) => `  ✗ ${t}`),
    ...warnings.map((t) => `  ! ${t}`),
    ...ok.map((t) => `  ✓ ${t}`),
  ].join('\n');
}

module.exports = { preflight, format };
