// Service worker do canal "Push" (Configurações > Notificações > Regras) —
// réplica do kyvvo-studio (server/panel/public/push-sw.js). Fica na raiz do
// static de propósito — escopo padrão de um SW é o diretório onde ele está
// (/crm/, já que fastifyStatic serve `public/` sob o prefixo /crm/),
// cobrindo todas as páginas do produto. Só os dois eventos de push abaixo,
// sem nenhum papel de cache/offline (não intercepta fetch).
self.addEventListener('push', (event) => {
  let dados = {};
  try {
    dados = event.data ? event.data.json() : {};
  } catch {
    dados = { titulo: event.data ? event.data.text() : 'Kyvvo CRM' };
  }
  const titulo = dados.titulo || 'Kyvvo CRM';
  event.waitUntil(
    self.registration.showNotification(titulo, {
      body: dados.corpo || '',
      icon: '/ds/favicon.svg',
      data: { url: dados.url || '/crm/painel.html' },
    })
  );
});

// Foca uma aba já aberta no CRM em vez de abrir outra sempre que possível.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/crm/painel.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((janelas) => {
      for (const janela of janelas) {
        if (janela.url.includes('/crm/') && 'focus' in janela) return janela.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
      return null;
    })
  );
});
