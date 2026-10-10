'use strict';

// A test client profile: fixed outlets, menu and brand, independent of any
// real client's data (which changes as the business grows). Requiring it makes
// it the active client.
const { useClient } = require('../../src/brand');
const menu = require('./menu');
const localities = require('./localities');

const outlets = [
  { slug: 'sec-17-chd', upiId: 'tk-sec-17-chd@example', waPaymentConfig: 'tk-sec-17-chd', name: 'Test Kitchen - Sector 17', city: 'Chandigarh', address: 'SCO 00, Sector 17-C, Chandigarh', lat: 30.7410, lng: 76.7790, phone: '+910000000001', radiusKm: 20, opens: '11:00', closes: '23:00' },
  { slug: 'sec-35-chd', upiId: 'tk-sec-35-chd@example', waPaymentConfig: 'tk-sec-35-chd', name: 'Test Kitchen - Sector 35', city: 'Chandigarh', address: 'SCO 00, Sector 35-C, Chandigarh', lat: 30.7225, lng: 76.7570, phone: '+910000000002', radiusKm: 20, opens: '11:00', closes: '23:00' },
  { slug: 'manimajra', upiId: 'tk-manimajra@example', waPaymentConfig: 'tk-manimajra', name: 'Test Kitchen - Manimajra', city: 'Chandigarh', address: 'Main Market, Manimajra, Chandigarh', lat: 30.7290, lng: 76.8380, phone: '+910000000003', radiusKm: 20, opens: '11:00', closes: '23:00' },
  { slug: 'phase-7-mohali', upiId: 'tk-phase-7-mohali@example', waPaymentConfig: 'tk-phase-7-mohali', name: 'Test Kitchen - Phase 7 Mohali', city: 'Mohali', address: 'SCO 00, Phase 7, SAS Nagar, Mohali', lat: 30.7085, lng: 76.7195, phone: '+910000000004', radiusKm: 20, opens: '11:00', closes: '23:00' },
  { slug: 'kharar', upiId: 'tk-kharar@example', waPaymentConfig: 'tk-kharar', name: 'Test Kitchen - Kharar', city: 'Kharar', address: 'Landran Road, Kharar', lat: 30.7460, lng: 76.6450, phone: '+910000000005', radiusKm: 20, opens: '11:00', closes: '23:00' },
  { slug: 'zirakpur', upiId: 'tk-zirakpur@example', waPaymentConfig: 'tk-zirakpur', name: 'Test Kitchen - Zirakpur', city: 'Zirakpur', address: 'VIP Road, Zirakpur', lat: 30.6420, lng: 76.8170, phone: '+910000000006', radiusKm: 20, opens: '11:00', closes: '23:00' },
  { slug: 'sec-11-pkl', upiId: 'tk-sec-11-pkl@example', waPaymentConfig: 'tk-sec-11-pkl', name: 'Test Kitchen - Sector 11 Panchkula', city: 'Panchkula', address: 'SCO 00, Sector 11, Panchkula', lat: 30.6960, lng: 76.8480, phone: '+910000000007', radiusKm: 20, opens: '11:00', closes: '23:00' },
];

const brand = {
  id: 'test-kitchen', name: 'Test Kitchen', outletPrefix: 'Test Kitchen - ', emoji: '🥡',
  orderExample: '2 half kurkure veg momo less spicy and 1 full veg hakka noodles no onion',
  region: { name: 'the tricity', state: 'Chandigarh', bounds: { minLat: 29, maxLat: 32.5, minLng: 74.5, maxLng: 78.5 } },
};

module.exports = useClient({ brand, outlets, menu, localities });
