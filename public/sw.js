self.addEventListener('push', function(event) {
    let data = { title: 'Restaurant Update', body: 'New notification from kitchen.' };
    if (event.data) {
        data = event.data.json();
    }

    const options = {
        body: data.body,
        icon: '/icon.png', // Optional icon path if available
        badge: '/badge.png'
    };

    event.waitUntil(
        self.registration.showNotification(data.title, options)
    );
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    event.waitUntil(
        clients.openWindow('/')
    );
});