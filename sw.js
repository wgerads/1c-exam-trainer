/**
 * Service worker тренажёра: после первого открытия приложение работает полностью
 * офлайн — весь банк вопросов и код лежат в кэше браузера.
 *
 * Стратегия: cache-first для своих файлов (приложение статично и самодостаточно),
 * переходы по навигации отдаются из кэша с подстраховкой index.html.
 * Имя кэша содержит версию, поэтому после пересборки банка старый кэш удаляется
 * (версию подставляет tools/build-web.mjs).
 *
 * ВАЖНО: service worker работает только на https:// или на http://localhost.
 * При открытии страницы как файла (file://) он просто не регистрируется —
 * приложение при этом работает как обычно, только без офлайн-кэша.
 */

const VERSION = '2026-11-05-exam';
const CACHE = `1c-trainer-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './app-core.js',
  './data/questions.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-48.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Кэшируем по одному файлу: если чего-то не окажется, установка всё равно
      // состоится, а недостающий файл просто попадёт в кэш при первом запросе.
      await Promise.all(
        ASSETS.map((asset) =>
          cache.add(new Request(asset, { cache: 'reload' })).catch((error) => {
            console.warn('Не удалось закэшировать', asset, error);
          }),
        ),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cached = await caches.match(request, { ignoreSearch: true });
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response && response.ok && response.type === 'basic') {
          const cache = await caches.open(CACHE);
          cache.put(request, response.clone());
        }
        return response;
      } catch (error) {
        // Офлайн и файла нет в кэше: для навигации отдаём главную страницу.
        if (request.mode === 'navigate') {
          const fallback = await caches.match('./index.html');
          if (fallback) return fallback;
        }
        throw error;
      }
    })(),
  );
});
