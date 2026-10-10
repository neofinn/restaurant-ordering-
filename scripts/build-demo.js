'use strict';

// Builds a single self-contained HTML demo (dist/demo.html): the customer web
// app, WhatsApp chat, outlet dashboard and a live routing map, all running the
// real code from src/ in the browser on an in-memory store.
//
//   npm run build:demo [-- out/file.html]
//
// With --pages <dir> it also writes each screen as its own page (order.html,
// outlet.html, admin.html, whatsapp.html, track.html) for static hosting such
// as GitHub Pages. The pages share one in-browser backend through a
// SharedWorker, so an order placed in one tab shows up in the others.

const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { brand, brandPage } = require('../src/brand');
const { dirFor } = require('../src/client-profile');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const args = process.argv.slice(2);
const pagesAt = args.indexOf('--pages');
const pagesDir = pagesAt >= 0 ? path.resolve(args.splice(pagesAt, 2)[1]) : null;
const out = path.resolve(args[0] || path.join(root, 'dist', 'demo.html'));

// Swap Node-only modules for browser versions.
const browserShims = {
  name: 'browser-shims',
  setup(build) {
    build.onResolve({ filter: /^node:(events|crypto|path)$/ }, () => ({ path: path.join(root, 'demo', 'shims.js') }));
    build.onResolve({ filter: /^\.\.?\/config$/ }, (args) => {
      const resolved = path.resolve(args.resolveDir, args.path);
      return resolved === path.join(root, 'src', 'config') ? { path: path.join(root, 'demo', 'config.js') } : undefined;
    });
    // The client chosen with CLIENT=<id> is built in (a bundle can't pick a folder at run time).
    build.onResolve({ filter: /^\.\/client-profile$/ }, () => ({ path: 'client-profile', namespace: 'client' }));
    build.onLoad({ filter: /.*/, namespace: 'client' }, () => ({
      contents: `const p = require(${JSON.stringify(dirFor(process.env.CLIENT))}); module.exports = () => p;`,
      resolveDir: root,
    }));
  },
};

// Runs inside each embedded page: routes fetch() to the in-browser backend
// held by the parent page, and turns GPS/navigation into messages to it.
const CHILD_SHIM = `<script>
(() => {
  window.RC_DEMO = true;
  const pending = new Map();
  let seq = 0;
  const ask = (msg) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    parent.postMessage({ ...msg, rc: true, id }, '*');
  });
  window.addEventListener('message', (e) => {
    if (e.source !== parent || !e.data || !e.data.rc) return;
    if (e.data.reply) {
      const p = pending.get(e.data.id);
      if (p) { pending.delete(e.data.id); p(e.data); }
    }
    if (e.data.fill) {
      const input = document.getElementById('t');
      if (input) { input.value = e.data.fill; input.form.requestSubmit(); }
    }
  });
  window.fetch = async (url, opts = {}) => {
    const auth = (opts.headers && (opts.headers.Authorization || opts.headers.authorization)) || '';
    const r = await ask({ kind: 'fetch', method: (opts.method || 'GET').toUpperCase(), url: String(url), body: opts.body ? JSON.parse(opts.body) : null, token: auth.replace(/^Bearer\\s+/i, ''), ownerToken: (opts.headers && (opts.headers['X-Owner-Unlock'] || opts.headers['x-owner-unlock'])) || '' });
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return new Response(text, { status: r.status, headers: { 'Content-Type': 'application/json' } });
  };
  // "Use my location" uses the demo position chosen on the parent page.
  const geo = {
    getCurrentPosition(ok) {
      ask({ kind: 'gps' }).then((r) => setTimeout(() => ok({ coords: { latitude: r.lat, longitude: r.lng, accuracy: 20 } }), 400));
    },
  };
  try { Object.defineProperty(navigator, 'geolocation', { value: geo, configurable: true }); } catch { /* keep default */ }
  window.RC_NAVIGATE = (url) => parent.postMessage({ rc: true, kind: 'nav', url }, '*');
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href^="/"]');
    if (a) { e.preventDefault(); window.RC_NAVIGATE(a.getAttribute('href')); }
  }, true);
})();
</script>`;

// Standalone pages: talk to the shared demo backend and map server paths to page files.
const STANDALONE_SHIM = `<script>
(() => {
  window.RC_DEMO = true;
  window.RC_STANDALONE = true;
  const PAGES = { '/': 'order.html', '/index.html': 'order.html', '/track.html': 'track.html', '/outlet/': 'outlet.html', '/admin/': 'admin.html', '/whatsapp-sim.html': 'whatsapp.html' };
  const pageUrl = (u) => { const x = new URL(u, 'https://demo.local'); return (PAGES[x.pathname] || x.pathname.slice(1)) + x.search; };
  window.RC_NAVIGATE = (u) => { location.href = pageUrl(u); };
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href^="/"]');
    if (a) { e.preventDefault(); location.href = pageUrl(a.getAttribute('href')); }
  }, true);

  let send;
  const ready = new Promise((resolve) => {
    if (window.SharedWorker) {
      try {
        const pending = new Map();
        let seq = 0;
        const w = new SharedWorker('demo-worker.js', { name: '${brand().id}-demo' });
        w.port.onmessage = (e) => { const p = pending.get(e.data.id); if (p) { pending.delete(e.data.id); p(e.data); } };
        w.port.start();
        send = (msg) => new Promise((r) => { const id = ++seq; pending.set(id, r); w.port.postMessage({ ...msg, id }); });
        return resolve();
      } catch (e) { /* fall back below */ }
    }
    // No SharedWorker (e.g. Chrome on Android): this tab runs the demo backend
    // itself; it is still saved in the browser, so other pages pick it up.
    const load = (src) => new Promise((r) => { const s = document.createElement('script'); s.src = src; s.onload = r; document.head.appendChild(s); });
    load('demo-backend.js').then(() => load('demo-server.js')).then(() => {
      send = (m) => RCDemoServer.handle(m);
      resolve();
    });
  });
  // ?reset starts the demo again from scratch.
  if (new URLSearchParams(location.search).has('reset')) {
    ready.then(() => send({ kind: 'reset' })).then(() => {
      try { for (const k of Object.keys(localStorage)) if (/^(rc\\.|rca\\.|rco\\.|sim\\.)/.test(k)) localStorage.removeItem(k); } catch (e) { /* storage blocked */ }
      location.replace(location.pathname);
    });
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!/^\\/(api|webhooks)\\//.test(u)) return realFetch(url, opts);
    await ready;
    const auth = (opts.headers && (opts.headers.Authorization || opts.headers.authorization)) || '';
    const r = await send({ method: (opts.method || 'GET').toUpperCase(), url: u, body: opts.body ? JSON.parse(opts.body) : null, token: auth.replace(/^Bearer\\s+/i, ''), ownerToken: (opts.headers && (opts.headers['X-Owner-Unlock'] || opts.headers['x-owner-unlock'])) || '' });
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return new Response(text, { status: r.status, headers: { 'Content-Type': 'application/json' } });
  };
})();
</script>`;

// Runs the demo backend once for every open page of the site.
const WORKER = `importScripts('demo-backend.js', 'demo-server.js');
onconnect = (e) => {
  const port = e.ports[0];
  port.onmessage = async ({ data }) => {
    const res = await RCDemoServer.handle(data);
    port.postMessage({ id: data.id, ...res });
  };
  port.start();
};
`;

function inlinePage(file, shim = CHILD_SHIM) {
  let html = read(file)
    .replace(/<link rel="stylesheet" href="(\/[^"]+)">/g, (_, href) => `<style>${read('public' + href)}</style>`)
    .replace(/<script src="(\/[^"]+)"><\/script>/g, (_, src) => `<script>${read('public' + src).replace(/<\/script/gi, '<\\/script')}</script>`);
  html = html.replace('<head>', () => `<head>\n${shim}`);
  return brandPage(html);
}

async function main() {
  const bundle = await esbuild.build({
    entryPoints: [path.join(root, 'demo', 'backend.js')],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'RCBackend',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    plugins: [browserShims],
    // Native PNG renderer: server only (the demo shows menu pages as SVG).
    external: ['@resvg/resvg-js'],
  });
  const backend = bundle.outputFiles[0].text;

  const pages = {
    web: inlinePage('public/index.html'),
    track: inlinePage('public/track.html'),
    admin: inlinePage('public/admin/index.html'),
    outlet: inlinePage('public/outlet/index.html'),
    whatsapp: inlinePage('public/whatsapp-sim.html'),
  };
  const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

  const html = brandPage(read('demo/shell.html'))
    .replace('</style>', () => `  :root:root { --wok: ${brand().colors.brand}; }\n</style>`)
    .replace('/*__BACKEND__*/', () => backend.replace(/<\/script/gi, '<\\/script'))
    .replace('/*__PAGES__*/', () => `const PAGES = ${json(pages)};\nconst BRAND = ${json(brand())};`);

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  console.log(`Wrote ${path.relative(process.cwd(), out)} (${Math.round(html.length / 1024)} KB)`);

  if (pagesDir) {
    fs.mkdirSync(pagesDir, { recursive: true });
    const files = {
      'order.html': inlinePage('public/index.html', STANDALONE_SHIM),
      'track.html': inlinePage('public/track.html', STANDALONE_SHIM),
      'outlet.html': inlinePage('public/outlet/index.html', STANDALONE_SHIM),
      'admin.html': inlinePage('public/admin/index.html', STANDALONE_SHIM),
      'whatsapp.html': inlinePage('public/whatsapp-sim.html', STANDALONE_SHIM),
      'demo-backend.js': backend,
      'demo-worker.js': WORKER,
      'demo-server.js': read('demo/standalone-server.js'),
      // Landing page with the separate links (the all-in-one page is dist/demo.html).
      'index.html': brandPage(read('demo/links.html')),
    };
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(pagesDir, name), text);
    console.log(`Wrote ${Object.keys(files).length} standalone files to ${path.relative(process.cwd(), pagesDir)}/`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
