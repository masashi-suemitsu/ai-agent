self.addEventListener('push', event => {
  try {
    const data = event.data.json();
    event.waitUntil(
      self.registration.showNotification(data.title || 'AIエージェント', {
        body: data.body || '',
        icon: '/assets/logo.png',
        badge: '/assets/logo.png',
        data: { url: data.url || '/manage' },
        requireInteraction: false
      })
    );
  } catch(e) {
    event.waitUntil(self.registration.showNotification('AIエージェント通知', { body: event.data?.text() || '' }));
  }
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/manage';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes(url));
      if (existing) return existing.focus();
      return clients.openWindow(url);
    })
  );
});
