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

const VERSION = '2026-11-05-images';
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
  './images/questions/set-10-q026.webp',
  './images/questions/set-10-q054.webp',
  './images/questions/set-10-q064.webp',
  './images/questions/set-10-q067.webp',
  './images/questions/set-10-q073.webp',
  './images/questions/set-10-q076.webp',
  './images/questions/set-10-q077.webp',
  './images/questions/set-10-q080.webp',
  './images/questions/set-10-q081.webp',
  './images/questions/set-10-q083.webp',
  './images/questions/set-10-q085.webp',
  './images/questions/set-10-q086.webp',
  './images/questions/set-10-q087.webp',
  './images/questions/set-10-q088.webp',
  './images/questions/set-10-q089.webp',
  './images/questions/set-10-q093.webp',
  './images/questions/set-10-q094.webp',
  './images/questions/set-10-q095.webp',
  './images/questions/set-10-q096.webp',
  './images/questions/set-10-q097.webp',
  './images/questions/set-10-q098.webp',
  './images/questions/set-10-q099.webp',
  './images/questions/set-10-q100.webp',
  './images/questions/set-10-q101.webp',
  './images/questions/set-10-q102.webp',
  './images/questions/set-10-q110.webp',
  './images/questions/set-10-q112.webp',
  './images/questions/set-11-q011.webp',
  './images/questions/set-11-q012.webp',
  './images/questions/set-11-q029.webp',
  './images/questions/set-11-q042.webp',
  './images/questions/set-11-q043.webp',
  './images/questions/set-11-q044.webp',
  './images/questions/set-11-q045.webp',
  './images/questions/set-11-q049.webp',
  './images/questions/set-11-q050.webp',
  './images/questions/set-11-q051.webp',
  './images/questions/set-12-q055.webp',
  './images/questions/set-12-q056.webp',
  './images/questions/set-12-q057.webp',
  './images/questions/set-12-q058.webp',
  './images/questions/set-12-q059.webp',
  './images/questions/set-12-q060.webp',
  './images/questions/set-12-q061.webp',
  './images/questions/set-12-q071.webp',
  './images/questions/set-12-q072.webp',
  './images/questions/set-14-q042.webp',
  './images/questions/set-14-q051.webp',
  './images/questions/set-14-q053.webp',
  './images/questions/set-14-q055.webp',
  './images/questions/set-2-q009.webp',
  './images/questions/set-2-q023.webp',
  './images/questions/set-2-q024.webp',
  './images/questions/set-2-q028.webp',
  './images/questions/set-3-q007.webp',
  './images/questions/set-3-q011.webp',
  './images/questions/set-3-q013.webp',
  './images/questions/set-3-q027.webp',
  './images/questions/set-3-q065.webp',
  './images/questions/set-4-q011.webp',
  './images/questions/set-4-q013.webp',
  './images/questions/set-4-q016.webp',
  './images/questions/set-4-q019.webp',
  './images/questions/set-4-q028.webp',
  './images/questions/set-4-q031.webp',
  './images/questions/set-4-q032.webp',
  './images/questions/set-4-q039.webp',
  './images/questions/set-5-q009.webp',
  './images/questions/set-5-q030.webp',
  './images/questions/set-5-q031.webp',
  './images/questions/set-5-q039.webp',
  './images/questions/set-5-q043.webp',
  './images/questions/set-5-q056.webp',
  './images/questions/set-8-q004.webp',
  './images/questions/set-8-q007.webp',
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
