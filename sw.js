/* Family Player service worker.
   Streams Google Drive videos to the <video> player by adding your sign-in
   token to each request (a plain <video src> can't send it). Supports seeking
   by passing the browser's Range requests straight through to Drive.
   It also keeps a copy of the page itself, so the player opens with no
   internet (offline mode plays files saved on this device). */

const TOKEN_CACHE = 'fp-token';
const TOKEN_KEY = new URL('__fp_token', self.registration.scope).href;
let token = null;
const SHELL_CACHE = 'fp-shell-v1';
const SHELL_URL = new URL('index.html', self.registration.scope).href;

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.add(SHELL_URL)).catch(() => {}));
});
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type === 'token' && d.token) {
    token = d.token;
    e.waitUntil(caches.open(TOKEN_CACHE).then(c => c.put(TOKEN_KEY, new Response(token))));
  } else if (d.type === 'claim') {
    // Page was loaded with a hard refresh (Ctrl+Shift+R), which bypasses this
    // helper; take control of it now.
    e.waitUntil(self.clients.claim());
  } else if (d.type === 'signout') {
    token = null;
    e.waitUntil(caches.delete(TOKEN_CACHE));
  }
});

async function getToken() {
  if (token) return token;
  // The browser may have stopped and restarted this worker; recover the token.
  const c = await caches.open(TOKEN_CACHE);
  const r = await c.match(TOKEN_KEY);
  if (r) token = await r.text();
  return token;
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  // Only the player page itself (scope/ or scope/index.html) is kept for offline use.
  if (e.request.mode === 'navigate' && (url.href.split(/[?#]/)[0] === self.registration.scope || url.href.split(/[?#]/)[0] === SHELL_URL)) { e.respondWith(page(e.request)); return; }
  const m = url.pathname.match(/\/drive-stream\/([\w-]+)$/);
  if (!m) return;
  e.respondWith(stream(m[1], Number(url.searchParams.get('size')) || 0, e.request));
});

// Opening the page: always try the network first (so updates arrive), keep the
// latest copy, and fall back to it when there's no connection.
async function page(req) {
  const c = await caches.open(SHELL_CACHE);
  try {
    const r = await fetch(req);
    if (r.ok && (r.headers.get('Content-Type') || '').includes('text/html')) c.put(SHELL_URL, r.clone()).catch(() => {});
    return r;
  } catch (err) {
    return (await c.match(SHELL_URL)) || new Response('<h1>Offline</h1><p>Open the player once while online first.</p>', { status: 503, headers: { 'Content-Type': 'text/html' } });
  }
}

async function stream(id, size, req) {
  const t = await getToken();
  if (!t) { notifyAuth(); return fail(401, 'Not signed in (streaming helper has no sign-in token)'); }

  const headers = { Authorization: 'Bearer ' + t };
  const range = req.headers.get('range');
  if (range) headers.Range = range;

  let r;
  try {
    r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, { headers });
  } catch (err) {
    return fail(502, 'Could not reach Google Drive: ' + err.message);
  }
  if (!r.ok) {
    if (r.status === 401) { token = null; notifyAuth(); }
    let body = '';
    try { body = await r.text(); } catch {}
    return fail(r.status, body); // pass Drive's own error message through for diagnosis
  }

  const h = new Headers({ 'X-FP-SW': '1' });
  h.set('Content-Type', r.headers.get('Content-Type') || 'video/mp4');
  h.set('Accept-Ranges', 'bytes');
  const len = r.headers.get('Content-Length');
  if (len) h.set('Content-Length', len);

  // Content-Range may be hidden by CORS; rebuild it from the request + known file size.
  let cr = r.headers.get('Content-Range');
  if (r.status === 206 && !cr && range && size) {
    const mm = range.match(/bytes=(\d+)-(\d*)/);
    if (mm) {
      const start = Number(mm[1]);
      const end = len ? start + Number(len) - 1 : (mm[2] ? Math.min(Number(mm[2]), size - 1) : size - 1);
      cr = `bytes ${start}-${end}/${size}`;
    }
  }
  if (cr) h.set('Content-Range', cr);

  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

// Error responses are marked X-FP-SW so the page can tell "this helper answered"
// apart from "the request fell through to the web host".
function fail(status, text) {
  return new Response(text || '', { status, headers: { 'Content-Type': 'text/plain', 'X-FP-SW': '1' } });
}

async function notifyAuth() {
  const list = await self.clients.matchAll({ type: 'window' });
  list.forEach(c => c.postMessage({ type: 'auth-expired' }));
}
