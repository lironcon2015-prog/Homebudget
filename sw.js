const CACHE_VERSION = 'finance-v1.42.0'
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './mobile.css',
  './mobile/mobile-detect.js',
  './mobile/shell.js',
  './mobile/dashboard.js',
  './mobile/transactions.js',
  './mobile/analysis.js',
  './mobile/recurring.js',
  './mobile/property.js',
  './app.js',
  './core.js',
  './txmatch.js',
  './source.js',
  './ui.js',
  './uikit.js',
  './icons.js',
  './templates.js',
  './wizard.js',
  './budget.js',
  './budgetGen.js',
  './recurring.js',
  './dashboard.js',
  './transactions.js',
  './import.js',
  './analysis.js',
  './settings.js',
  './drive.js',
  './backupLocal.js',
  './autocat.js',
  './detect.js',
  './property.js',
  './propertyDocs.js',
  './reports.js',
  './feedback.js',
  './scrollMirror.js',
  './palette.js',
  './insights.js',
  './anomalies.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './icons/favicon-16.png',
  './icons/favicon.ico',
]

self.addEventListener('install', e => {
  self.skipWaiting()
  e.waitUntil(caches.open(CACHE_VERSION).then(c => c.addAll(ASSETS)))
})

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', e => {
  // חסימה מוחלטת: אסור ל-Service Worker לגעת בקריאות API (דרייב / AI / GitHub)
  if (e.request.url.includes('googleapis.com')) return
  if (e.request.url.includes('api.github.com')) return

  // network-first for HTML and version.json
  const url = new URL(e.request.url)
  if (url.pathname.endsWith('.html') || url.pathname.endsWith('version.json') || url.pathname.endsWith('/')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)))
    return
  }

  // strip query params for cache matching (cache-busting ?v=)
  const cleanUrl = url.origin + url.pathname
  e.respondWith(
    caches.match(cleanUrl).then(r => r || caches.match(e.request)).then(r => r || fetch(e.request))
  )
})

self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting()
})
