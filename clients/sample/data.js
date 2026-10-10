'use strict';

// Sample client: placeholder outlets and a generic menu so the system runs out
// of the box. Replace with the client's own (see clients/README.md).
//
// Outlets: name, address, map point (lat, lng), phone, delivery range and
// hours. UPI IDs ending in "@example" are deliberately invalid.
// Menu: prices in rupees; a dish sold in two sizes is two items named
// "Dish (Half)" and "Dish (Full)".
// Localities: places customers type in an address ("Sector 22", "Phase 7"),
// with a map point each, so a typed address can be routed without GPS.

const outlets = [
  { slug: 'sec-17', upiId: 'outlet-sec-17@example', waPaymentConfig: 'outlet-sec-17', name: 'Your Restaurant - Sector 17', city: 'Chandigarh', address: 'SCO 00, Sector 17-C, Chandigarh', lat: 30.7410, lng: 76.7790, phone: '+910000000001', radiusKm: 20, opens: '11:00', closes: '23:00' },
  { slug: 'phase-7', upiId: 'outlet-phase-7@example', waPaymentConfig: 'outlet-phase-7', name: 'Your Restaurant - Phase 7', city: 'Mohali', address: 'SCO 00, Phase 7, Mohali', lat: 30.7085, lng: 76.7195, phone: '+910000000002', radiusKm: 20, opens: '11:00', closes: '23:00' },
  { slug: 'sec-11-pkl', upiId: 'outlet-sec-11-pkl@example', waPaymentConfig: 'outlet-sec-11-pkl', name: 'Your Restaurant - Sector 11', city: 'Panchkula', address: 'SCO 00, Sector 11, Panchkula', lat: 30.6960, lng: 76.8480, phone: '+910000000003', radiusKm: 20, opens: '11:00', closes: '23:00' },
  { slug: 'zirakpur', upiId: 'outlet-zirakpur@example', waPaymentConfig: 'outlet-zirakpur', name: 'Your Restaurant - VIP Road', city: 'Zirakpur', address: 'VIP Road, Zirakpur', lat: 30.6420, lng: 76.8170, phone: '+910000000004', radiusKm: 20, opens: '11:00', closes: '23:00' },
];

const menu = [
  { category: "Starters", name: "Veg Spring Roll", price: 149, veg: true },
  { category: "Starters", name: "Paneer Tikka (Half)", description: "Cottage cheese, tandoor-roasted", price: 189, veg: true },
  { category: "Starters", name: "Paneer Tikka (Full)", description: "Cottage cheese, tandoor-roasted", price: 329, veg: true },
  { category: "Starters", name: "Chilli Paneer (Half)", price: 179, veg: true },
  { category: "Starters", name: "Chilli Paneer (Full)", price: 299, veg: true },
  { category: "Starters", name: "Crispy Corn", price: 169, veg: true },
  { category: "Starters", name: "Chicken Tikka (Half)", price: 219, veg: false },
  { category: "Starters", name: "Chicken Tikka (Full)", price: 389, veg: false },
  { category: "Starters", name: "Chicken 65", price: 229, veg: false },
  { category: "Soups", name: "Tomato Soup", price: 99, veg: true },
  { category: "Soups", name: "Sweet Corn Soup", price: 109, veg: true },
  { category: "Soups", name: "Chicken Clear Soup", price: 129, veg: false },
  { category: "Main Course", name: "Dal Makhani (Half)", price: 169, veg: true },
  { category: "Main Course", name: "Dal Makhani (Full)", price: 279, veg: true },
  { category: "Main Course", name: "Shahi Paneer (Half)", price: 199, veg: true },
  { category: "Main Course", name: "Shahi Paneer (Full)", price: 329, veg: true },
  { category: "Main Course", name: "Kadai Paneer (Half)", price: 199, veg: true },
  { category: "Main Course", name: "Kadai Paneer (Full)", price: 329, veg: true },
  { category: "Main Course", name: "Mix Veg", price: 189, veg: true },
  { category: "Main Course", name: "Butter Chicken (Half)", price: 249, veg: false },
  { category: "Main Course", name: "Butter Chicken (Full)", price: 429, veg: false },
  { category: "Main Course", name: "Chicken Curry (Half)", price: 229, veg: false },
  { category: "Main Course", name: "Chicken Curry (Full)", price: 399, veg: false },
  { category: "Rice & Biryani", name: "Jeera Rice", price: 129, veg: true },
  { category: "Rice & Biryani", name: "Veg Biryani (Half)", price: 159, veg: true },
  { category: "Rice & Biryani", name: "Veg Biryani (Full)", price: 259, veg: true },
  { category: "Rice & Biryani", name: "Veg Fried Rice (Half)", price: 129, veg: true },
  { category: "Rice & Biryani", name: "Veg Fried Rice (Full)", price: 199, veg: true },
  { category: "Rice & Biryani", name: "Chicken Biryani (Half)", price: 199, veg: false },
  { category: "Rice & Biryani", name: "Chicken Biryani (Full)", price: 329, veg: false },
  { category: "Breads", name: "Tandoori Roti", price: 20, veg: true },
  { category: "Breads", name: "Butter Roti", price: 25, veg: true },
  { category: "Breads", name: "Butter Naan", price: 45, veg: true },
  { category: "Breads", name: "Garlic Naan", price: 60, veg: true },
  { category: "Breads", name: "Lachha Paratha", price: 50, veg: true },
  { category: "Noodles & Pasta", name: "Veg Hakka Noodles (Half)", price: 129, veg: true },
  { category: "Noodles & Pasta", name: "Veg Hakka Noodles (Full)", price: 199, veg: true },
  { category: "Noodles & Pasta", name: "Chicken Hakka Noodles (Half)", price: 149, veg: false },
  { category: "Noodles & Pasta", name: "Chicken Hakka Noodles (Full)", price: 229, veg: false },
  { category: "Noodles & Pasta", name: "White Sauce Pasta", price: 219, veg: true },
  { category: "Noodles & Pasta", name: "Red Sauce Pasta", price: 209, veg: true },
  { category: "Meals", name: "Veg Thali", description: "Dal, paneer, seasonal veg, rice, 2 rotis, salad", price: 249, veg: true },
  { category: "Meals", name: "Non-Veg Thali", description: "Chicken curry, dal, rice, 2 rotis, salad", price: 329, veg: false },
  { category: "Meals", name: "Rajma Chawal Bowl", price: 179, veg: true },
  { category: "Desserts", name: "Gulab Jamun (2 pcs)", price: 69, veg: true },
  { category: "Desserts", name: "Brownie with Ice Cream", price: 149, veg: true },
  { category: "Beverages", name: "Sweet Lassi", price: 79, veg: true },
  { category: "Beverages", name: "Masala Chaas", price: 59, veg: true },
  { category: "Beverages", name: "Cold Coffee", price: 119, veg: true },
  { category: "Beverages", name: "Fresh Lime Soda", price: 79, veg: true },
];

const localities = [
  ['Sector 8', 'Chandigarh', 30.7410, 76.8010], ['Sector 9', 'Chandigarh', 30.7480, 76.7930],
  ['Sector 15', 'Chandigarh', 30.7520, 76.7680], ['Sector 17', 'Chandigarh', 30.7410, 76.7790],
  ['Sector 22', 'Chandigarh', 30.7330, 76.7720], ['Sector 26', 'Chandigarh', 30.7300, 76.8070],
  ['Sector 32', 'Chandigarh', 30.7150, 76.7780], ['Sector 35', 'Chandigarh', 30.7225, 76.7570],
  ['Sector 43', 'Chandigarh', 30.7180, 76.7400], ['Sector 44', 'Chandigarh', 30.7080, 76.7550],
  ['Industrial Area Phase 1', 'Chandigarh', 30.7050, 76.8000], ['Manimajra', 'Chandigarh', 30.7290, 76.8380],
  ['Phase 3B2', 'Mohali', 30.7230, 76.7120], ['Phase 5', 'Mohali', 30.7140, 76.7200],
  ['Phase 7', 'Mohali', 30.7085, 76.7195], ['Phase 10', 'Mohali', 30.6930, 76.7310],
  ['Sector 70', 'Mohali', 30.6990, 76.7140], ['Sector 82 (IT City)', 'Mohali', 30.6680, 76.7180],
  ['Kharar', 'Kharar', 30.7460, 76.6450], ['Landran', 'Kharar', 30.7020, 76.6630],
  ['Zirakpur VIP Road', 'Zirakpur', 30.6420, 76.8170], ['Dhakoli', 'Zirakpur', 30.6560, 76.8420],
  ['Sector 5', 'Panchkula', 30.6940, 76.8600], ['Sector 11', 'Panchkula', 30.6960, 76.8480],
  ['Sector 20', 'Panchkula', 30.6710, 76.8410], ['Sector 26', 'Panchkula', 30.6870, 76.8800],
  ['Mansa Devi', 'Panchkula', 30.7310, 76.8610], ['Chandimandir', 'Panchkula', 30.7220, 76.8850],
  ['Peer Muchalla', 'Zirakpur', 30.6720, 76.8450], ['Bhabat', 'Zirakpur', 30.6400, 76.8250],
  ['Aerocity', 'Mohali', 30.6630, 76.7330], ['Sohana', 'Mohali', 30.6830, 76.7000], ['TDI City', 'Mohali', 30.6480, 76.6900],
  ['Sunny Enclave', 'Kharar', 30.7350, 76.6600], ['New Chandigarh', 'Mullanpur', 30.7870, 76.6950],
  ['PGI', 'Chandigarh', 30.7650, 76.7760], ['IT Park', 'Chandigarh', 30.7270, 76.8450],
  ['Pinjore', 'Pinjore', 30.7970, 76.9170], ['Dera Bassi', 'Dera Bassi', 30.5880, 76.8430],
  ['Kurali', 'Kurali', 30.8360, 76.5740], ['Banur', 'Banur', 30.5560, 76.7160],
].map(([name, city, lat, lng]) => ({ name, city, lat, lng }));

module.exports = { outlets, menu, localities };
