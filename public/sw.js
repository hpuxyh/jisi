// 集思 Service Worker
// 策略：
//   - 静态资源（JS/CSS/图标）→ stale-while-revalidate（先用缓存秒开，后台更新下次用新）
//   - HTML（导航请求）→ network-first（保证页面是最新版）
//   - /api/* → 直通不缓存（数据接口必须实时）

const VERSION = 'v1';
const STATIC_CACHE = `jisi-static-${VERSION}`;

self.addEventListener('install', (event) => {
  // 立即激活新版本
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // 清理旧版本缓存
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== STATIC_CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 只处理同源 GET
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // 接口直通
  if (url.pathname.startsWith('/api/')) return;

  // 导航请求（HTML 页面）→ network-first
  if (req.mode === 'navigate' || req.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(STATIC_CACHE).then(c => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then(r => r || caches.match('/')))
    );
    return;
  }

  // 静态资源（JS / CSS / 图标 / 字体）→ stale-while-revalidate
  if (/\.(js|css|png|svg|woff2?|ttf|jpg|jpeg|webp|ico|json)$/i.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then(cached => {
        const network = fetch(req).then(res => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(STATIC_CACHE).then(c => c.put(req, copy)).catch(() => {});
          }
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
  }
});
