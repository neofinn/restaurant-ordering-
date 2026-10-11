'use strict';

// Marketplace: the restaurants that deliver to the customer's location, each
// linking to its own ordering site with the location already filled in.

(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rupees = (p) => `₹${Math.round(p / 100)}`;
  const color = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : '');
  const err = (m) => { $('err').textContent = m || ''; $('err').classList.toggle('hidden', !m); };

  async function show(lat, lng, label) {
    err('');
    $('list').innerHTML = '<p class="muted">Finding restaurants…</p>';
    let list;
    try {
      const res = await fetch(`/api/marketplace/nearby?lat=${lat}&lng=${lng}`);
      list = await res.json();
      if (!res.ok) throw new Error(list.error || 'Something went wrong');
    } catch (e) { $('list').innerHTML = ''; return err(e.message); }
    if (!list.length) { $('list').innerHTML = `<p class="muted">No restaurants deliver to ${esc(label)} yet.</p>`; return; }
    $('list').innerHTML = list.map((r) => `
      <a class="rest ${r.open ? '' : 'closed'}" href="${esc(`${r.url}&label=${encodeURIComponent(label)}`)}" style="--c:${color(r.colors?.brand)}">
        <span class="em">${esc(r.emoji)}</span>
        <span>
          <h3>${esc(r.name)}</h3>
          <p class="small muted">${esc(r.description)}</p>
          <p class="small">${r.open ? `${r.etaMinutes} min · ${r.distanceKm} km · delivery ${rupees(r.deliveryCharge)}` : 'Closed right now'}</p>
        </span>
        <span class="go">${r.open ? 'Order →' : 'Menu →'}</span>
      </a>`).join('');
  }

  $('gps').addEventListener('click', () => {
    if (!navigator.geolocation) return err('Location is not supported on this device. Choose your area instead.');
    $('gps').disabled = true;
    navigator.geolocation.getCurrentPosition(
      (p) => { $('gps').disabled = false; show(p.coords.latitude, p.coords.longitude, 'your location'); },
      () => { $('gps').disabled = false; err('Couldn\'t get your location. Choose your area instead.'); },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  });
  $('area').addEventListener('change', () => {
    const o = $('area').selectedOptions[0];
    if (o?.dataset.lat) show(Number(o.dataset.lat), Number(o.dataset.lng), o.textContent);
  });

  fetch('/api/marketplace/localities').then((r) => r.json()).then((ls) => {
    const byCity = new Map();
    for (const l of ls) byCity.set(l.city, [...(byCity.get(l.city) || []), l]);
    $('area').insertAdjacentHTML('beforeend', [...byCity].map(([city, items]) => `<optgroup label="${esc(city)}">${items.map((l) => `<option data-lat="${l.lat}" data-lng="${l.lng}">${esc(l.name)}, ${esc(city)}</option>`).join('')}</optgroup>`).join(''));
  }).catch(() => {});
})();
