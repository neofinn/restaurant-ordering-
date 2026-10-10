'use strict';

// UPI payments. Every order gets its own UPI request for the exact amount,
// paid to the UPI ID of the outlet that cooks it, with the order code as the
// reference so staff can match it in their UPI app / bank statement.
//
// The QR code and the upi:// link open any UPI app (GPay, PhonePe, Paytm,
// BHIM) with payee, amount and note filled in. Confirmation is manual (staff
// tap "Paid" once it shows in their UPI app). With a payment gateway
// configured (src/gateway.js), the link is our /pay/<code> page instead and the
// gateway's webhook confirms the payment.

const QRCode = require('qrcode');
const config = require('./config');
const { brand } = require('./brand');

const PAYMENT_LABELS = {
  cod: 'Cash/UPI on delivery',
  pending: 'UPI payment pending',
  claimed: 'Customer says paid, check UPI app',
  paid: 'Paid online',
  refunded: 'Refunded',
};

/**
 * Where an outlet's UPI payments go: { id, name } or null. The outlet's own UPI
 * ID wins, unless it is a placeholder (…@example) and a business-wide UPI_ID is set.
 */
function upiFor(outlet) {
  const own = outlet?.upi_id || null;
  const global = config.upi?.id || null;
  const id = own && !(global && /@example$/i.test(own)) ? own : global;
  if (!id) return null;
  const name = (id === own && outlet.upi_name) || config.upi?.payeeName || brand().name;
  return { id, name };
}

/** upi:// payment link (NPCI deep-link format): payee, exact amount, order code as reference. */
function upiLink({ upiId, payee, amountPaise, code, merchantCode = config.upi?.merchantCode }) {
  const params = [
    ['pa', upiId],
    ['pn', payee],
    ...(merchantCode ? [['mc', merchantCode]] : []),
    ['am', (amountPaise / 100).toFixed(2)],
    ['cu', 'INR'],
    ['tn', `${brand().name} order ${code}`],
    ['tr', code],
  ];
  return 'upi://pay?' + params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

/** QR code as an SVG string (works in Node and in the browser demo). */
function qrSvg(text, { size = 240, margin = 3 } = {}) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const total = n + margin * 2;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.get(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="UPI payment QR code"><rect width="${total}" height="${total}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

/** QR code as PNG (server only), for WhatsApp image messages. */
function qrPng(text) {
  return QRCode.toBuffer(text, { errorCorrectionLevel: 'M', width: 600, margin: 3 });
}

// WhatsApp amounts are { value, offset } with offset 100 = paise.
const money = (paise) => ({ value: Math.round(paise), offset: 100 });

/**
 * WhatsApp "Review and pay" message (interactive order_details, India UPI).
 * The customer pays inside WhatsApp or picks any UPI app; WhatsApp reports
 * the result to our webhook with reference_id = order code.
 * Amounts must add up: items (incl. packing) = subtotal; subtotal + tax
 * (GST) + shipping (delivery charge) = total.
 */
function orderDetailsReply(order, outlet, { goodsType = 'digital-goods', now = new Date() } = {}) {
  const items = order.items.map((i) => ({
    retailer_id: `RC-${i.item_id}`,
    name: (i.note ? `${i.name} (${i.note})` : i.name).slice(0, 60),
    amount: money(i.price),
    quantity: i.qty,
  }));
  if (order.packing) items.push({ retailer_id: 'RC-PACKING', name: 'Packing charges', amount: money(order.packing), quantity: 1 });
  return {
    type: 'order_details',
    text: `Order ${order.code} · ${outlet.name}\nPay with WhatsApp UPI or any UPI app.`,
    referenceId: order.code,
    paymentConfiguration: outlet.wa_payment_config,
    goodsType,
    total: order.total,
    order: {
      status: 'pending',
      items,
      subtotal: order.subtotal + (order.packing || 0),
      tax: { value: order.gst, description: 'GST 5%' },
      ...(order.delivery_fee ? { shipping: { value: order.delivery_fee, description: `Delivery${order.distance_km != null ? ` (${order.distance_km} km)` : ''}` } } : {}),
      // Unpaid requests expire after an hour; the QR and cash stay available.
      expiration: { timestamp: Math.floor(now.getTime() / 1000) + 3600, description: 'Payment request expired. Pay by QR or cash.' },
    },
  };
}

/** Cloud API payload for an order_details reply. */
function orderDetailsPayload(r) {
  const amt = (v) => money(v);
  return {
    type: 'order_details',
    body: { text: r.text },
    action: {
      name: 'review_and_pay',
      parameters: {
        reference_id: r.referenceId,
        type: r.goodsType,
        payment_type: 'upi',
        payment_configuration: r.paymentConfiguration,
        currency: 'INR',
        total_amount: amt(r.total),
        order: {
          status: r.order.status,
          items: r.order.items,
          subtotal: amt(r.order.subtotal),
          tax: { ...amt(r.order.tax.value), description: r.order.tax.description },
          ...(r.order.shipping ? { shipping: { ...amt(r.order.shipping.value), description: r.order.shipping.description } } : {}),
          expiration: r.order.expiration,
        },
      },
    },
  };
}

// Our order status -> WhatsApp order card status.
const WA_ORDER_STATUS = {
  accepted: 'processing', preparing: 'processing', ready: 'processing', out_for_delivery: 'shipped',
  completed: 'completed', cancelled: 'canceled',
};

module.exports = { upiFor, upiLink, qrSvg, qrPng, orderDetailsReply, orderDetailsPayload, WA_ORDER_STATUS, PAYMENT_LABELS };
