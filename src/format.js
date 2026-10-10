'use strict';

/** ₹ formatting for paise amounts: 12900 -> "₹129", 12950 -> "₹129.50". */
function rupees(paise) {
  const r = paise / 100;
  return '₹' + (Number.isInteger(r) ? r.toLocaleString('en-IN') : r.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
}

module.exports = { rupees };
