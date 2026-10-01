// Envio de e-mail pelo serviço da plataforma (kyvvo-platform,
// POST /internal/email/send — SES, log e lista de supressão centralizados).
// O produto é identificado pelo PLATFORM_EMAIL_TOKEN (SSM /kyvvo/<svc>/).
//
// Transição: sem PLATFORM_EMAIL_TOKEN, cai na chamada direta à Resend de
// antes (RESEND_API_KEY/RESEND_FROM); sem nenhum dos dois, modo log (dev).
// Best-effort: nunca lança, devolve true só se o e-mail saiu de verdade.
//
// Mesmo arquivo em kyvvo-studio, kyvvo-people e kyvvo-crm.

const PLATFORM_URL = process.env.PLATFORM_URL || 'http://platform:3003';

async function viaPlatform({ to, subject, html, text, tag, fromName, replyTo }, { env, fetchImpl }) {
  const res = await fetchImpl(`${env.PLATFORM_URL || PLATFORM_URL}/internal/email/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Token': env.PLATFORM_EMAIL_TOKEN },
    body: JSON.stringify({ to, subject, html, text, tag, fromName, replyTo }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const corpo = await res.text().catch(() => '');
    console.error(`[email] platform respondeu ${res.status} ao enviar "${subject}": ${corpo.slice(0, 300)}`);
    return false;
  }
  return true;
}

async function viaResend({ to, subject, html, text, replyTo }, { env, fetchImpl }) {
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.RESEND_FROM || 'Kyvvo <no-reply@kyvvo.com.br>',
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text,
      reply_to: replyTo || undefined,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    console.error(`[email] Resend respondeu ${res.status} ao enviar "${subject}"`);
    return false;
  }
  return true;
}

// msg: { to, subject, html?, text?, tag?, fromName?, replyTo? }
async function enviarEmail(msg, deps = {}) {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  try {
    if (env.PLATFORM_EMAIL_TOKEN) return await viaPlatform(msg, { env, fetchImpl });
    if (env.RESEND_API_KEY) return await viaResend(msg, { env, fetchImpl });
    console.log(`[email] (dev) "${msg.subject}" para ${[].concat(msg.to).join(', ')}`);
    return false;
  } catch (err) {
    console.error(`[email] Falha ao enviar "${msg.subject}": ${err.message}`);
    return false;
  }
}

module.exports = { enviarEmail };
