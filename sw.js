/* 视频库 · 本机版的 Service Worker
   ------------------------------------------------------------
   用相对路径，所以放在根目录、子目录（GitHub Pages 项目路径）、
   任何静态托管下都能正常工作。

   策略：网络优先，失败回退缓存。
   —— 在线时拿到最新代码
   —— 断网时靠缓存把页面打开
   ------------------------------------------------------------ */

const CACHE = 'vault-local-v3';

// 相对于这个 SW 所在目录（self.registration.scope）
const FILES = [
  'index.html',
  'local.js',
  'style.css',
  'manifest.json',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(async (c) => {
      for (const f of FILES) {
        const url = new URL(f, self.registration.scope).href;
        try {
          const res = await fetch(url, { cache: 'reload' });
          if (res && res.ok) await c.put(url, res);
        } catch {
          // 单个文件失败不影响整体
        }
      }
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }

  const scopeUrl = new URL(self.registration.scope);
  if (url.origin !== scopeUrl.origin) return;

  const scopePath = scopeUrl.pathname;
  let p = url.pathname;

  // 访问目录根（/repo/ 或 /repo）时，按 index.html 处理
  if (p === scopePath || p === scopePath.replace(/\/$/, '')) p = scopePath + 'index.html';

  if (!FILES.some((f) => p === scopePath + f)) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        // 根路径没有精确缓存项，退回 index.html
        const idx = await caches.match(new URL('index.html', self.registration.scope).href);
        if (idx) return idx;
        return Response.error();
      })
  );
});