const cacheName = 'parts-tracker-v1';
const appShell = ['./', './index.html', './app.js', './config.js'];
const cdnAssets = [
	'https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css',
	'https://unpkg.com/html5-qrcode',
	'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

self.addEventListener('install', event => {
	event.waitUntil((async () => {
		const cache = await caches.open(cacheName);
		await cache.addAll(appShell);
		await Promise.all(cdnAssets.map(async url => {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 8000);
			try {
				const response = await fetch(url, { mode: 'no-cors', signal: controller.signal });
				await cache.put(url, response);
			} catch {
				// The app shell can still be cached when a CDN is unavailable.
			} finally {
				clearTimeout(timeout);
			}
		}));
		await self.skipWaiting();
	})());
});

self.addEventListener('activate', event => {
	event.waitUntil((async () => {
		const cacheNames = await caches.keys();
		await Promise.all(cacheNames
			.filter(name => name.startsWith('parts-tracker-') && name !== cacheName)
			.map(name => caches.delete(name)));
		await self.clients.claim();
	})());
});

self.addEventListener('fetch', event => {
	const request = event.request;
	if (request.method !== 'GET') return;

	const url = new URL(request.url);
	const isAppShell = url.origin === self.location.origin;
	const isCdnAsset = cdnAssets.some(asset => asset === url.href);
	if (!isAppShell && !isCdnAsset) return;

	event.respondWith((async () => {
		const cache = await caches.open(cacheName);
		const cached = await cache.match(request);

		try {
			const response = await fetch(request);
			if (response.ok || response.type === 'opaque') {
				await cache.put(request, response.clone());
			}
			return response;
		} catch (error) {
			if (cached) return cached;
			if (request.mode === 'navigate') {
				const fallback = await cache.match('./index.html');
				if (fallback) return fallback;
			}
			throw error;
		}
	})());
});
