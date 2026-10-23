// Notificação push no navegador (Web Push/VAPID) — canal "CRM" de
// Configurações > Notificações > Regras (lib/notificacoes.js#canaisAtivos),
// réplica do kyvvo-studio (server/panel/lib/push.js). Chaves em
// VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY (SSM /kyvvo/crm/) — sem elas, modo log
// (dev), mesmo espírito de lib/email.js. Best-effort: nunca lança.
const webpush = require('web-push');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:contato@kyvvo.com.br', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// Manda pra TODAS as assinaturas do tenant (um usuário pode ter ativado em
// mais de um navegador/dispositivo). Assinatura expirada/revogada pelo
// push service do navegador (404/410) é removida na hora — não tem sentido
// tentar de novo depois.
async function enviarPush(pool, tenantId, { titulo, corpo, url }) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.log(`[push] (dev) tenant ${tenantId}: ${titulo}`);
    return;
  }
  const { rows } = await pool.query(
    'SELECT id, endpoint, p256dh, auth FROM crm_push_subscriptions WHERE tenant_id = $1',
    [tenantId]
  );
  if (!rows.length) return;

  const payload = JSON.stringify({ titulo, corpo, url: url || '/crm/painel.html' });
  await Promise.all(rows.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await pool.query('DELETE FROM crm_push_subscriptions WHERE id = $1', [sub.id]).catch(() => {});
      } else {
        console.error(`[push] falha ao enviar pra assinatura ${sub.id}: ${err.message}`);
      }
    }
  }));
}

module.exports = { enviarPush, VAPID_PUBLIC_KEY };
