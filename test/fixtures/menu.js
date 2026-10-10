'use strict';

// The placeholder menu the tests were written against (dish names, prices and
// variants they refer to). The real menu in src/seed.js can change freely.
const menu = [
  { category: 'Soups', name: 'Veg Manchow Soup', price: 89, veg: true },
  { category: 'Soups', name: 'Veg Hot & Sour Soup', price: 89, veg: true },
  { category: 'Soups', name: 'Sweet Corn Soup', price: 89, veg: true },
  { category: 'Soups', name: 'Chicken Manchow Soup', price: 109, veg: false },
  { category: 'Soups', name: 'Chicken Hot & Sour Soup', price: 109, veg: false },

  { category: 'Momos', name: 'Veg Steam Momos (8 pcs)', price: 79, veg: true },
  { category: 'Momos', name: 'Veg Fried Momos (8 pcs)', price: 99, veg: true },
  { category: 'Momos', name: 'Paneer Momos (8 pcs)', price: 119, veg: true },
  { category: 'Momos', name: 'Chicken Steam Momos (8 pcs)', price: 109, veg: false },
  { category: 'Momos', name: 'Chicken Fried Momos (8 pcs)', price: 129, veg: false },
  { category: 'Momos', name: 'Kurkure Momos (8 pcs)', price: 139, veg: true },

  { category: 'Starters', name: 'Veg Spring Roll', price: 109, veg: true },
  { category: 'Starters', name: 'Honey Chilli Potato', price: 139, veg: true },
  { category: 'Starters', name: 'Chilli Paneer Dry', price: 179, veg: true },
  { category: 'Starters', name: 'Crispy Corn', price: 149, veg: true },
  { category: 'Starters', name: 'Chilli Chicken Dry', price: 199, veg: false },
  { category: 'Starters', name: 'Chicken Lollipop (6 pcs)', price: 219, veg: false },

  { category: 'Noodles', name: 'Veg Hakka Noodles', price: 119, veg: true },
  { category: 'Noodles', name: 'Chilli Garlic Noodles', price: 129, veg: true },
  { category: 'Noodles', name: 'Schezwan Noodles', price: 129, veg: true },
  { category: 'Noodles', name: 'Egg Hakka Noodles', price: 139, veg: false },
  { category: 'Noodles', name: 'Chicken Hakka Noodles', price: 159, veg: false },

  { category: 'Rice', name: 'Veg Fried Rice', price: 119, veg: true },
  { category: 'Rice', name: 'Schezwan Fried Rice', price: 129, veg: true },
  { category: 'Rice', name: 'Egg Fried Rice', price: 139, veg: false },
  { category: 'Rice', name: 'Chicken Fried Rice', price: 159, veg: false },

  { category: 'Main Course', name: 'Veg Manchurian Gravy', price: 149, veg: true },
  { category: 'Main Course', name: 'Chilli Paneer Gravy', price: 189, veg: true },
  { category: 'Main Course', name: 'Chilli Chicken Gravy', price: 209, veg: false },

  { category: 'Combos', name: 'Noodles + Manchurian Combo', price: 179, veg: true, description: 'Hakka noodles with veg manchurian gravy' },
  { category: 'Combos', name: 'Fried Rice + Chilli Paneer Combo', price: 219, veg: true, description: 'Veg fried rice with chilli paneer gravy' },
  { category: 'Combos', name: 'Fried Rice + Chilli Chicken Combo', price: 239, veg: false, description: 'Chicken fried rice with chilli chicken gravy' },

  { category: 'Beverages', name: 'Coke (300 ml)', price: 40, veg: true },
  { category: 'Beverages', name: 'Masala Lemonade', price: 59, veg: true },
];

module.exports = menu;
