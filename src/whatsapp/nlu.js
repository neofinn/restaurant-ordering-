'use strict';

// Understands free-text orders typed the way people message a restaurant,
// in English or Hinglish:
//
//   "2 chilli paneer dry less spicy, ek veg chowmein no onion"
//   "bhaiya 3 momos and 1 coke"
//
// Returns matched cart lines with per-item special instructions, items that
// need the customer to choose between variants (e.g. "chilli paneer": dry or
// gravy?), order-level requests, and anything that could not be understood.
// Pure and dependency-free so it also runs in the browser demo.

const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, ek: 1, single: 1,
  two: 2, do: 2, double: 2, three: 3, teen: 3, four: 4, char: 4, chaar: 4,
  five: 5, paanch: 5, panch: 5, six: 6, chhe: 6, che: 6, seven: 7, saat: 7,
  eight: 8, aath: 8, nine: 9, nau: 9, ten: 10, das: 10,
};

// Common spellings and menu slang mapped onto words used in item names.
const ALIASES = {
  chowmein: 'noodles', chowmin: 'noodles', chaumin: 'noodles', chowmeen: 'noodles', noodle: 'noodles', noodels: 'noodles',
  momo: 'momos', momoz: 'momos', dumplings: 'momos', dumpling: 'momos',
  chilly: 'chilli', chili: 'chilli', chilie: 'chilli',
  manchuriyan: 'manchurian', manchurain: 'manchurian', manchoorian: 'manchurian',
  szechuan: 'schezwan', shezwan: 'schezwan', schezuan: 'schezwan', sechwan: 'schezwan', schezwaan: 'schezwan',
  manchau: 'manchow', manchow: 'manchow',
  springroll: 'spring roll', rolls: 'roll',
  lolipop: 'lollipop', lollypop: 'lollipop',
  chiken: 'chicken', chikan: 'chicken', murgh: 'chicken',
  panner: 'paneer', panir: 'paneer',
  steamed: 'steam', fry: 'fried', frid: 'fried',
  coca: 'coke', cola: 'coke', pepsi: 'coke', 'cold drink': 'coke', 'soft drink': 'coke',
  nimbu: 'lemonade', shikanji: 'lemonade', lemon: 'lemonade',
  corn: 'corn', makki: 'corn',
  potato: 'potato', aloo: 'potato',
  hot: 'hot', sour: 'sour',
  kurkure: 'kurkure', crispy: 'crispy',
};

// Portion words: "half plate veg noodles", "2 full chilli potato", "chhota/bada".
const PORTION_WORDS = /\b(half|full|small|large|big|chhota|chota|bada|badi)\b/;
const portionFor = (w) => (/half|small|chh?ota/.test(w) ? 'Half' : 'Full');

// Words that carry no meaning for matching.
const STOPWORDS = new Set(('i want need would like to please pls plz send me give get order bhaiya bhai bhaiyya ji sir '
  + 'and aur also plus with of the my for can you have kindly chahiye dena de bhej bhejo dedo dijiye '
  + 'plate plates pcs pc piece pieces full portion portions packet packets glass bottle hi hello hey namaste '
  + 'ok okay thanks thank u it is that this some more of x qty quantity').split(/\s+/));

// Special-instruction phrases. Matched text is moved into the line's note.
const NOTE_PATTERNS = [
  /\b(?:less|kam|light|mild|medium|extra|more|zyada|jyada|very|double|not|no)\s+(?:spicy|spice|teekha|tikha|mirchi|chilli|oil|tel|salt|namak|sauce|gravy|crispy|cheese|garlic|onion|pyaz|pyaaz|ginger|msg|ajinomoto|sugar|ice|mayo|mayonnaise)\b/g,
  /\b(?:without|bina|no)\s+(?:any\s+)?(?:onion|onions|pyaz|pyaaz|garlic|lehsun|ginger|capsicum|cabbage|msg|ajinomoto|egg|ice|sauce|mayo|chutney|chilli|mirchi|spice|spices)\b/g,
  /\b(?:jain|jain style|non spicy|non-spicy|not spicy|kid friendly|for kids|bachon ke liye)\b/g,
  /\b(?:well done|extra soft|extra crispy)\b/g,
  /\b(?:sauce|chutney|mayo)\s+(?:alag|separate|separately|on the side)\b/g,
  /\b(?:separate|alag)\s+(?:packing|pack|box)\b/g,
];

// Order-level requests that don't belong to one item.
const ORDER_NOTE_PATTERNS = [
  /\b(?:everything|sab|all|saara|sara)\b.*\b(?:spicy|teekha|tikha|oil|onion|garlic|jain)\b.*/,
  /\b(?:call|phone|ring)\b.*\b(?:before|reach|arrive|coming|aate|pahunch)\b.*/,
  /\b(?:cutlery|spoon|spoons|chopsticks|napkin|napkins|tissue)\b.*/,
  /\b(?:birthday|party|guests|anniversary)\b.*/,
  /\b(?:don'?t|do not|mat)\s+ring\b.*/,
  /\b(?:leave|chhod)\b.*\b(?:door|gate|guard)\b.*/,
];

const normalise = (s) => s.toLowerCase()
  .replace(/[’']/g, "'")
  .replace(/&/g, ' and ')
  .replace(/(\d+)\s*x\b/g, '$1 ')
  .replace(/\bx\s*(\d+)\b/g, ' $1')
  .replace(/[^a-z0-9'\s+-]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const stem = (w) => (w.length > 4 && w.endsWith('es') && !w.endsWith('oes') ? w.slice(0, -1) : w).replace(/(?<=.{3})s$/, '');

function tokens(s) {
  let t = ` ${s} `;
  for (const [from, to] of Object.entries(ALIASES)) {
    if (from.includes(' ')) t = t.replaceAll(` ${from} `, ` ${to} `);
  }
  return t.trim().split(/[\s+-]+/)
    .map((w) => ALIASES[w] || w)
    .flatMap((w) => w.split(' '))
    .filter((w) => w && !STOPWORDS.has(w) && !/^\d+$/.test(w))
    .map(stem);
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

const sameWord = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && editDistance(a, b) <= 1);

/** Pre-compute item tokens once per menu. */
function indexMenu(menu) {
  return menu.map((item) => ({
    item,
    words: tokens(normalise(item.name.replace(/\(.*?\)/g, ''))),
  }));
}

/** Score candidates for a query; returns the best-scoring items (ties kept). */
function matchItem(queryWords, index) {
  if (!queryWords.length) return [];
  const scored = index.map(({ item, words }) => {
    const hits = queryWords.filter((q) => words.some((w) => sameWord(q, w))).length;
    return { item, query: hits / queryWords.length, cover: hits / words.length };
  }).filter((s) => s.query >= 0.6);
  if (!scored.length) return [];
  scored.sort((a, b) => b.query - a.query || b.cover - a.cover);
  const best = scored.filter((s) => s.query === scored[0].query);
  // Every word of an item's name mentioned: that's the one ("veg manchurian gravy").
  const exact = best.filter((s) => s.cover === 1);
  // Half and Full of the same dish count as one match ("chilli potato").
  const exactDishes = new Set(exact.map((s) => s.item.name.replace(/\s*\((Half|Full)\)$/, '')));
  return (exact.length && exactDishes.size === 1 ? exact : best).map((s) => s.item);
}

function extractQty(segment) {
  const digits = segment.match(/(?:^|\s)(\d{1,2})(?=\s|$)/);
  if (digits) return { qty: Number(digits[1]) || 1, rest: segment.replace(digits[0], ' ').trim() };
  // A number word counts as a quantity only before the item: "do chowmein", "one coke".
  const words = segment.split(' ');
  const i = words.findIndex((w) => !STOPWORDS.has(w) || NUMBER_WORDS[w]);
  if (i >= 0 && NUMBER_WORDS[words[i]] && words.length > i + 1) {
    return { qty: NUMBER_WORDS[words[i]], rest: words.filter((_, j) => j !== i).join(' ') };
  }
  return { qty: 1, rest: segment };
}

function extractNotes(segment, patterns) {
  const notes = [];
  let rest = segment;
  for (const re of patterns) {
    rest = rest.replace(re, (m) => { notes.push(m.trim()); return ' '; });
  }
  return { notes, rest: rest.replace(/\s+/g, ' ').trim() };
}

/** Split a message into one segment per item. */
function segments(text) {
  const numberWords = Object.keys(NUMBER_WORDS).filter((w) => w.length > 1).join('|');
  // "and"/"aur" only separates items when a quantity follows: "1 noodles and 2 momos",
  // not "hot and sour soup".
  const joiner = new RegExp(`\\s(?:and|aur|plus|also|\\+)\\s(?=(?:\\d{1,2}|${numberWords}|a|an)\\s)`);
  return String(text)
    .split(/[\n,;]+|\.(?:\s|$)/)
    .flatMap((part) => normalise(part).split(joiner))
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse a free-text message against the menu.
 * menu: [{id, name, available, ...}]
 * Returns { lines, choices, orderNotes, unknown, isOrder }:
 *   lines:      [{id, qty, note}]  confidently matched
 *   choices:    [{qty, note, query, options: [item]}]  ambiguous, ask the customer
 *   orderNotes: [string]           requests for the whole order
 *   unknown:    [string]           text we could not map to anything
 */
function parseOrderText(text, menu) {
  const index = indexMenu(menu);
  const out = { lines: [], choices: [], orderNotes: [], unknown: [] };
  for (const seg of segments(text)) {
    const orderNote = ORDER_NOTE_PATTERNS.find((re) => re.test(seg));
    if (orderNote) { out.orderNotes.push(seg); continue; }

    const { notes, rest: withPortion } = extractNotes(seg, NOTE_PATTERNS);
    const p = withPortion.match(PORTION_WORDS);
    const portion = p ? portionFor(p[1]) : null;
    const rest = p ? withPortion.replace(PORTION_WORDS, ' ').replace(/\s+/g, ' ').trim() : withPortion;
    const { qty, rest: query } = extractQty(rest);
    const words = tokens(query);
    let matches = matchItem(words, index);
    // "half"/"full" picks that portion of dishes sold in both.
    if (portion && matches.length > 1) {
      const fits = matches.filter((m) => !/\((Half|Full)\)$/.test(m.name) || m.name.endsWith(`(${portion})`));
      if (fits.length) matches = fits;
    }
    const note = notes.join(', ');

    if (matches.length === 1) out.lines.push({ id: matches[0].id, qty, note });
    else if (matches.length > 1) out.choices.push({ qty, note, query: words.join(' '), options: matches.slice(0, 20) });
    else if (!words.length && notes.length) out.orderNotes.push(note);
    else if (words.length) out.unknown.push(seg);
  }
  out.isOrder = out.lines.length > 0 || out.choices.length > 0;
  return out;
}

module.exports = { parseOrderText, segments, tokens, PORTION_WORDS };
