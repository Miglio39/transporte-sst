// Este código es un requisito obligatorio de los navegadores para permitir la instalación.
self.addEventListener('install', (event) => {
    console.log('Service Worker instalado.');
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('Service Worker activado.');
    return self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    // Solo dejamos pasar las peticiones de red normales
    event.respondWith(fetch(event.request).catch(() => {
        return new Response('Estás desconectado de internet.');
    }));
});