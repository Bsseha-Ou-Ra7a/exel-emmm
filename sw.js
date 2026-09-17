/* ==================================================================================
 *  Smart Business Manager — Service Worker
 *  ------------------------------------------------------------------------------
 *  Why a separate file? Browsers only accept a service worker from a real
 *  same-origin URL (blob:/data: URLs are rejected by the spec), so this file
 *  must sit next to index.html. It gives the app:
 *    • 100% offline support  (pre-cache of the whole app on install)
 *    • system notifications while the tab is in the background
 *    • Web-Push support      (fire a notification from any server/backend)
 *    • periodic background alert checks (low stock / due dates) where supported
 * ================================================================================== */

const VERSION = 'sbm-v3.0.0';
const STATIC_CACHE = `${VERSION}-static`;
const RUNTIME_CACHE = `${VERSION}-runtime`;
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

/* ------------------------------------------------------------------ install */
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    /* addAll() rejects the whole batch if one URL 404s — add individually instead */
    await Promise.all(PRECACHE.map(url => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    self.skipWaiting();
  })());
});

/* ------------------------------------------------------------------ activate */
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k)));
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.disable(); } catch (e) { }
    }
    await self.clients.claim();
  })());
});

/* ------------------------------------------------------------------ fetch */
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   /* never proxy third-party traffic */

  /* Navigations: cache-first with a network refresh (true offline start-up) */
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(STATIC_CACHE);
      const cached = await cache.match('./index.html') || await cache.match('./');
      const network = fetch(req).then(res => {
        if (res && res.ok) cache.put('./index.html', res.clone());
        return res;
      }).catch(() => null);
      return cached || (await network) || new Response(
        '<h1>Offline</h1><p>Open the app once while online to enable offline mode.</p>',
        { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 200 }
      );
    })());
    return;
  }

  /* Static assets: stale-while-revalidate */
  event.respondWith((async () => {
    const cache = await caches.open(RUNTIME_CACHE);
    const cached = await cache.match(req);
    const network = fetch(req).then(res => {
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    return cached || (await network) || new Response('', { status: 504, statusText: 'Offline' });
  })());
});

/* --------------------------------------------------- messages from the page */
self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') { self.skipWaiting(); return; }
  if (data.type === 'SHOW_NOTIFICATION' && data.payload) {
    event.waitUntil(showAlert(data.payload));
    return;
  }
  if (data.type === 'CHECK_ALERTS') {
    event.waitUntil(runBackgroundCheck(true));
  }
});

/* ------------------------------------------------------------ Web Push (server) */
self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch (e) { payload = { title: 'Smart Business Manager', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(showAlert({
    title: payload.title || 'Smart Business Manager',
    body: payload.body || payload.message || '',
    tag: payload.tag || 'sbm-push',
    level: payload.level || 'info',
    url: payload.url || './index.html',
  }));
});

/* ------------------------------------------------- periodic background sync */
self.addEventListener('periodicsync', event => {
  if (event.tag === 'sbm-alerts') event.waitUntil(runBackgroundCheck(false));
});

/* ------------------------------------------------------- notification clicks */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './index.html';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if ('focus' in client) {
        await client.focus();
        client.postMessage({ type: 'NAVIGATE', view: (event.notification.data && event.notification.data.view) || 'dashboard' });
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});

/* ------------------------------------------------------------------ helpers */
async function showAlert(payload) {
  const level = payload.level || 'info';
  await self.registration.showNotification(payload.title || 'Smart Business Manager', {
    body: payload.body || '',
    tag: payload.tag || `sbm-${Date.now()}`,
    renotify: !!payload.renotify,
    icon: './icon-192.png',
    badge: './icon-192.png',
    vibrate: level === 'danger' ? [90, 40, 90] : [60],
    lang: payload.lang || 'ar',
    dir: (payload.lang || 'ar') === 'ar' ? 'rtl' : 'ltr',
    data: { url: payload.url || './index.html', level },
  });
}

/* IndexedDB snapshot written by the page (Store.persistAlertsSnapshot) */
function idbGet(dbName, storeName, key) {
  return new Promise(resolve => {
    if (!self.indexedDB) return resolve(null);
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('alerts')) db.createObjectStore('alerts', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
    };
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(storeName)) return resolve(null);
      const tx = db.transaction(storeName, 'readonly');
      const get = tx.objectStore(storeName).get(key);
      get.onsuccess = () => resolve(get.result || null);
      get.onerror = () => resolve(null);
    };
  });
}

const STRINGS = {
  ar: { low: n => `مخزون منخفض: ${n}`, lowBody: (q, p) => `بقيت ${q} فقط (حد الطلب ${p}).`, out: n => `نفاد المخزون: ${n}`, outBody: q => `الكمية الحالية ${q} — يُنصح بإعادة الطلب.`, due: n => `${n} مبلغ مستحق اليوم أو قريبًا`, dueBody: n => `لديك ${n} حركة غير مدفوعة قاربت الاستحقاق.`, title: 'تنبيهات المدير الذكي' },
  fr: { low: n => `Stock faible : ${n}`, lowBody: (q, p) => `Il reste ${q} (seuil ${p}).`, out: n => `Rupture : ${n}`, outBody: q => `Quantité actuelle ${q} — réapprovisionner.`, due: n => `${n} échéance(s) proche(s)`, dueBody: n => `${n} transaction(s) non payée(s) arrivent à échéance.`, title: 'Alertes Gestion Pro' },
  en: { low: n => `Low stock: ${n}`, lowBody: (q, p) => `Only ${q} left (reorder point ${p}).`, out: n => `Out of stock: ${n}`, outBody: q => `Current quantity ${q} — restock recommended.`, due: n => `${n} payment(s) due soon`, dueBody: n => `${n} unpaid transaction(s) are approaching their due date.`, title: 'Smart Business alerts' },
};

/**
 * Recomputes the alert set from the snapshot the page mirrored into IndexedDB.
 * Runs on periodic-sync (and on demand) so alerts fire even with no tab open —
 * on browsers without Periodic Background Sync the page timer covers it instead.
 */
async function runBackgroundCheck(force) {
  const snap = await idbGet('sbm-store', 'alerts', 'current');
  if (!snap) return;
  const s = snap.settings || {};
  const L = STRINGS[s.lang] || STRINGS.ar;
  const today = new Date().toISOString().slice(0, 10);
  const todayKey = `sbm-checked-${today}`;
  const cache = await caches.open(RUNTIME_CACHE);
  const already = force ? null : await cache.match(new Request(`${self.location.origin}/__${todayKey}`));
  const dueSoonDays = Number(s.dueSoonDays) || 7;
  const items = [];

  if (s.notifLowStock !== false) {
    (snap.lowStock || []).forEach(i => {
      const point = Number(i.point) || 0;
      if (Number(i.qty) <= 0) items.push({ title: L.out(i.name), body: L.outBody(i.qty), tag: `out-${i.id}`, level: 'danger' });
      else items.push({ title: L.low(i.name), body: L.lowBody(i.qty, point), tag: `low-${i.id}`, level: 'warning' });
    });
  }
  if (s.notifDue !== false) {
    const dues = (snap.dues || []).filter(d => {
      if (!d.dueDate) return false;
      if (d.dueDate < today) return s.notifOverdue !== false;
      const diff = Math.round((new Date(d.dueDate + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000);
      return diff <= dueSoonDays;
    });
    if (dues.length) items.push({ title: L.due(dues.length), body: L.dueBody(dues.length), tag: 'sbm-dues', level: 'warning' });
  }

  if (items.length) {
    await setupNotificationChannel();
    for (const it of items.slice(0, 4)) await showAlert({ ...it, lang: s.lang || 'ar' });
    await cache.put(new Request(`${self.location.origin}/__${todayKey}`), new Response('1'));
  }
}

/* Ask the page (if any window is open) to brighten the in-app bell as well */
async function setupNotificationChannel() {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  all.forEach(c => c.postMessage({ type: 'ALERTS_FROM_SW', items: [] }));
}
