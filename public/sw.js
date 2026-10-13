self.addEventListener('push', function (event) {
    let data = { title: 'Restaurant Update', body: 'You have a new notification.' };
    try { data = event.data.json(); } catch (e) { /* ignore */ }

    event.waitUntil(
        self.registration.showNotification(data.title, {
            body: data.body,
            icon: '/icon-192.png',
            badge: '/icon-192.png'
        })
    );
});

self.addEventListener('notificationclick', function (event) {
    event.notification.close();
    event.waitUntil(clients.openWindow('/'));
});