'use strict';

// Browser-demo replacement for src/config.js (no env/fs). Pricing must stay in
// line with the server defaults.
module.exports = {
  production: false,
  get publicBaseUrl() { return `https://${require('../src/brand').brand().demo.domain}`; },
  adminToken: 'demo',
  timezone: 'Asia/Kolkata',
  pricing: {
    gstPercent: 5,
    packingPerOrder: 1000,
    minDeliveryOrder: 14900,
    freeDeliveryAbove: 0,
  },
  loyalty: { rupeesPerPoint: 100 },
  // Demo: unpaid UPI orders are cancelled after 3 minutes (15 in real life).
  payments: { windowMinutes: 3, provider: 'auto' },
  // Demo: ask for the review 20 seconds after delivery instead of 30 minutes.
  reviews: { delayMinutes: 1 / 3, webTemplate: '', templateLanguage: 'en' },
  delivery: { rangeKm: 20, partner: 'Shadowfax', baseKm: 3, baseFee: 4000, perKmFee: 1000 },
  whatsapp: { payments: true, goodsType: 'digital-goods', token: '', phoneNumberId: '', appSecret: '', verifyToken: '', graphVersion: 'v21.0' },
  // Connections tab: shown and editable in the demo, but nothing real is connected.
  upi: { id: '', payeeName: '', merchantCode: '5812' },
  razorpay: { keyId: '', keySecret: '', webhookSecret: '', baseUrl: 'https://api.razorpay.com/v1' },
  phonepe: { merchantId: '', saltKey: '', saltIndex: '1', env: 'sandbox' },
  shadowfax: { mode: 'simulate', token: '', baseUrl: 'https://hlbackend.staging.shadowfax.in', callbackToken: '', bookOn: 'accepted' },
  porter: { apiKey: '', baseUrl: 'https://pfe-apigw-uat.porter.in', callbackToken: '' },
  borzo: { token: '', baseUrl: 'https://robotapitest-in.borzodelivery.com/api/business/1.8', callbackSecret: '' },
  settingsKey: 'demo',
  // The demo never uses a real gateway (UPI QR flow only).
  paymentGateway: () => null,
};
