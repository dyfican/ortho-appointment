// Service Worker - 段医生正畸预约系统
// 缓存策略（M1）：
//  - 首屏 HTML：network-first（保证看到最新版，不卡旧壳）
//  - 静态资源（图标/manifest/js）：cache-first
//  - /api/sb/* 与 supabase.co：network-only，绝不缓存（医生端实时看板每次拉最新）
// 版本号 bump 流程（M5）：每次前端发布改 CACHE 常量 v1->v2... 旧缓存自动清理
const CACHE = 'ortho-shell-v3';
const SHELL = [
  '/',
  '/index.html',
  '/admin.html',
  '/manifest-patient.webmanifest',
  '/manifest-admin.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon.svg',
  '/icon-staff-192.png',
  '/icon-staff-512.png',
  '/icon-staff.svg',
  '/qrcode.min.js'
];
// 这些请求绝不走缓存，直接放行给浏览器发网络请求
const NO_CACHE = [
  '/api/sb/',        // 代理 API
  'supabase.co'      // Supabase REST/Auth
];

function isNoCache(url) {
  return NO_CACHE.some(p => url.pathname.startsWith(p) || url.hostname.includes(p));
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;            // 非 GET 不拦截
  const url = new URL(req.url);

  // API / Supabase：network-only，浏览器直接发网络请求，不 respondWith
  if (isNoCache(url)) return;

  // HTML 导航：network-first
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(resp => {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return resp;
      }).catch(() => caches.match(req).then(c => c || caches.match('/index.html')))
    );
    return;
  }

  // 静态资源：cache-first
  event.respondWith(
    caches.match(req).then(cached =>
      cached || fetch(req).then(resp => {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return resp;
      }).catch(() => cached)
    )
  );
});
