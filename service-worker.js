/* Evidente SW – precache + offline fallback (GitHub Pages /app-campo/) */
const BASE = '/app-campo/';            // escopo do seu site
const CACHE_NAME = 'evidente-v7';      // mude para v3, v4... quando atualizar assets

// Arquivos essenciais que devem abrir offline
const PRECACHE_URLS = [
  BASE,                                // index
  BASE + 'index.html',
  BASE + 'login.html',
  BASE + 'primeiro_acesso.html',
  BASE + 'seletor_lotes.html',
  BASE + 'profeta_diario_lote08.html',
  BASE + 'offline.html',
  BASE + 'manifest.webmanifest',
  BASE + 'queue.js',                   // fila offline
  BASE + 'send_data.gif',
  BASE + 'inicial.jpg',                // se existir na home
  BASE + 'provider.jpg',               // logo do login (se não existir, será ignorado)
  BASE + 'icons/icon-192.png',
  BASE + 'icons/icon-512.png'
  // adicione aqui outros CSS/JS/imagens fixos conforme for criando
];

// Instala e pré-carrega (tolerante a arquivos ausentes)
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    for (const url of PRECACHE_URLS) {
      try {
        await cache.add(url);
      } catch (e) {
        // Se algum arquivo não existir/404, apenas registra no console e segue.
        console.warn('[SW] Pulando no precache:', url, e?.message || e);
      }
    }
    self.skipWaiting(); // ativa logo a nova versão
  })());
});

// Ativa e remove caches antigos
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((n) => (n !== CACHE_NAME) && caches.delete(n)));
    self.clients.claim(); // assume controle sem precisar recarregar
  })());
});

// Estratégia:
// - Para navegações (HTML): network-first + fallback para offline.html
// - Para assets do mesmo domínio: cache-first
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isHTML = req.mode === 'navigate' ||
                 (req.headers.get('accept') || '').includes('text/html');
  const sameOrigin = url.origin === self.location.origin;

  if (isHTML) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req, { cache: 'no-store' });
        // atualiza cache em segundo plano
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match(req)) || (await cache.match(BASE + 'offline.html'));
      }
    })());
    return;
  }

  if (sameOrigin) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      if (cached) return cached; // rápido do cache
      try {
        const fresh = await fetch(req); // busca e guarda
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        return cached || Response.error();
      }
    })());
  }
});
