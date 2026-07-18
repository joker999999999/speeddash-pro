// SpeedDash Pro Service Worker
const CACHE_NAME = 'speeddash-pro-v2';
const URLS_TO_CACHE = [
  './',
  './index.html',
  './speedTest.js',
  './manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/3.9.1/chart.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
];

// Установка Service Worker
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return cache.addAll(URLS_TO_CACHE).catch(err => {
          console.log('Некоторые ресурсы не удалось кэшировать:', err);
        });
      })
      .then(() => self.skipWaiting())
  );
});

// Активация Service Worker
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Обработка запросов (стратегия Network First with Cache Fallback)
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(event.request.url);

  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  if (requestUrl.pathname.startsWith('/api')) {
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(async () => {
        const cachedIndex = await caches.match('./index.html');
        if (cachedIndex) {
          return cachedIndex;
        }

        return new Response('Оффлайн: кэш не найден', {
          status: 503,
          statusText: 'Service Unavailable'
        });
      })
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (!response || response.status !== 200 || response.type === 'error') {
          return response;
        }

        const responseToCache = response.clone();
        caches.open(CACHE_NAME)
          .then(cache => {
            cache.put(event.request, responseToCache);
          });

        return response;
      })
      .catch(() => {
        return caches.match(event.request)
          .then(response => {
            return response || new Response(
              'Нет подключения к интернету. Используется кэшированная версия.',
              { status: 503, statusText: 'Service Unavailable' }
            );
          });
      })
  );
});

// Обработка синхронизации данных при восстановлении интернета
self.addEventListener('sync', event => {
  if (event.tag === 'sync-tests') {
    event.waitUntil(syncTests());
  }
});

async function syncTests() {
  // Синхронизация данных тестов при восстановлении интернета
  try {
    console.log('Синхронизация тестов...');
    // Здесь можно отправить данные на сервер
  } catch (error) {
    console.error('Ошибка синхронизации:', error);
  }
}

// Обработка push-уведомлений
self.addEventListener('push', event => {
  const options = {
    body: event.data ? event.data.text() : 'SpeedDash Pro уведомление',
    icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect fill="%23667eea" width="192" height="192"/><text x="50%" y="50%" font-size="100" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="central">⚡</text></svg>',
    badge: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><text x="50%" y="50%" font-size="50" font-weight="bold" fill="%23667eea" text-anchor="middle" dominant-baseline="central">⚡</text></svg>',
    tag: 'speeddash-notification',
    requireInteraction: false,
  };

  event.waitUntil(
    self.registration.showNotification('SpeedDash Pro', options)
  );
});

// Обработка клика на уведомление
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        for (let client of clientList) {
          if (client.url.includes('/index.html') && 'focus' in client) {
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow('./index.html');
        }
      })
  );
});
