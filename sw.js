/* Family Player service worker.
   Streams Google Drive videos to the <video> player by adding your sign-in
   token to each request (a plain <video src> can't send it). Supports seeking
   by passing the browser's Range requests straight through to Drive. */

const TOKEN_CACHE = 'fp-token';
const TOKEN_KEY = new URL('__fp_token', self.registration.scope).href;
let token = null;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type === 'token' && d.token) {
    token = d.token;
    e.waitUntil(caches.open(TOKEN_CACHE).then(c => c.put(TOKEN_KEY, new Response(token))));
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
  const m = url.pathname.match(/\/drive-stream\/([\w-]+)$/);
  if (!m) return;
  e.respondWith(stream(m[1], Number(url.searchParams.get('size')) || 0, e.request));
});

async function stream(id, size, req) {
  const t = await getToken();
  if (!t) { notifyAuth(); return new Response('Not signed in', { status: 401 }); }

  const headers = { Authorization: 'Bearer ' + t };
  const range = req.headers.get('range');
  if (range) headers.Range = range;

  let r;
  try {
    r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, { headers });
  } catch (err) {
    return new Response('Network error', { status: 502 });
  }
  if (r.status === 401 || r.status === 403) { if (r.status === 401) { token = null; notifyAuth(); } return new Response(null, { status: r.status }); }
  if (!r.ok) return new Response(null, { status: r.status });

  const h = new Headers();
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

async function notifyAuth() {
  const list = await self.clients.matchAll({ type: 'window' });
  list.forEach(c => c.postMessage({ type: 'auth-expired' }));
}
