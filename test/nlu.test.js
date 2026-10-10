'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseOrderText } = require('../src/whatsapp/nlu');
const seed = require('./fixtures/seed');

const menu = seed.menu.map((m, i) => ({ ...m, id: i + 1, available: true }));
const name = (id) => menu.find((m) => m.id === id).name;
const parse = (t) => {
  const r = parseOrderText(t, menu);
  return {
    lines: r.lines.map((l) => [l.qty, name(l.id), l.note]),
    choices: r.choices.map((c) => [c.qty, c.options.map((o) => o.name)]),
    orderNotes: r.orderNotes,
    unknown: r.unknown,
  };
};

test('Hinglish quantities, aliases and per-item instructions', () => {
  assert.deepEqual(parse('ek veg chowmein no onion, do honey chilli potato extra crispy').lines, [
    [1, 'Veg Hakka Noodles', 'no onion'],
    [2, 'Honey Chilli Potato', 'extra crispy'],
  ]);
  assert.deepEqual(parse('4 chiken fried momos and 2 nimbu').lines, [
    [4, 'Chicken Fried Momos (8 pcs)', ''],
    [2, 'Masala Lemonade', ''],
  ]);
  assert.deepEqual(parse('2x veg manchurian gravy').lines, [[2, 'Veg Manchurian Gravy', '']]);
  assert.deepEqual(parse('2 veg hakka noodle jain').lines, [[2, 'Veg Hakka Noodles', 'jain']]);
});

test('"and" inside a dish name does not split it', () => {
  const r = parse('1 hot and sour soup and 2 chicken lollipop extra spicy');
  assert.deepEqual(r.lines, [[2, 'Chicken Lollipop (6 pcs)', 'extra spicy']]);
  assert.deepEqual(r.choices, [[1, ['Veg Hot & Sour Soup', 'Chicken Hot & Sour Soup']]]);
});

test('ambiguous dishes become questions, keeping quantity', () => {
  assert.deepEqual(parse('chicken momos').choices, [[1, ['Chicken Steam Momos (8 pcs)', 'Chicken Fried Momos (8 pcs)']]]);
  assert.equal(parse('bhaiya 3 momos').choices[0][0], 3);
  assert.equal(parse('bhaiya 3 momos').choices[0][1].length, 6);
});

test('order-level notes and unknown items', () => {
  const r = parse('2 crispy corn, everything less spicy please. call before coming');
  assert.deepEqual(r.lines, [[2, 'Crispy Corn', '']]);
  assert.deepEqual(r.orderNotes, ['everything less spicy please', 'call before coming']);
  assert.deepEqual(parse('2 pizza').unknown, ['2 pizza']);
  assert.deepEqual(parse('hi').lines, []);
});
