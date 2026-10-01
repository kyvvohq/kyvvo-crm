// Self-service de conexão do WhatsApp — Embedded Signup da Meta (WhatsApp
// Business Platform / Cloud API). Porta do kyvvo-studio
// (server/panel/meta-whatsapp-service.js) — mesmo fluxo, mesmas credenciais
// (META_APP_ID/META_APP_SECRET/META_WHATSAPP_TOKEN são do Usuário do
// Sistema compartilhado da Kyvvo, não por produto).
//
// Diferente do Studio: aqui não tem enviarTexto/enviarMensagemTeste — o CRM
// já usa @kyvvohq/whatsapp pra isso. Este arquivo só cobre os passos do
// próprio fluxo de conexão (troca de code, assinatura de webhook, atribuição
// do Usuário do Sistema, registro do número).
//
// Ponto chave da arquitetura: o token do Embedded Signup (vindo do `code`
// trocado em trocarCodePorToken) não é persistido — é usado só na hora, pra
// assinar os webhooks da WABA recém-conectada (assinarWebhooks), já que
// nesse momento o Usuário do Sistema ainda não tem acesso a ela.

const GRAPH_API_VERSION = 'v22.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

async function chamar(metodo, caminho, { query, body, token } = {}) {
  const url = new URL(`${GRAPH_API_BASE}${caminho}`);
  if (query) for (const [chave, valor] of Object.entries(query)) url.searchParams.set(chave, valor);

  const res = await fetch(url, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const dados = await res.json().catch(() => ({}));
  if (!res.ok) {
    const mensagem = (dados.error && dados.error.message) || `Meta respondeu ${res.status}`;
    throw new Error(mensagem);
  }
  return dados;
}

async function trocarCodePorToken(code) {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('META_APP_ID/META_APP_SECRET não configurados no servidor.');
  }
  return chamar('GET', '/oauth/access_token', {
    query: { client_id: appId, client_secret: appSecret, code },
  });
}

async function assinarWebhooks(wabaId, tokenCliente) {
  if (!tokenCliente) throw new Error('Token do cliente não fornecido para assinarWebhooks.');
  return chamar('POST', `/${wabaId}/subscribed_apps`, { token: tokenCliente });
}

async function atribuirUsuarioSistema(wabaId, tokenCliente) {
  const metaToken = process.env.META_WHATSAPP_TOKEN;
  if (!metaToken) throw new Error('META_WHATSAPP_TOKEN não configurado no servidor.');
  const { id: systemUserId } = await chamar('GET', '/me', { token: metaToken });
  return chamar('POST', `/${wabaId}/assigned_users`, {
    query: { user: systemUserId, tasks: JSON.stringify(['MANAGE']) },
    token: tokenCliente,
  });
}

// Best-effort: dependendo de como o Embedded Signup foi configurado, o
// número pode já vir registrado — erro aqui é logado mas não derruba a
// conexão (a WABA/telefone já foram salvos no tenant nesse ponto).
async function registrarNumero(phoneNumberId) {
  const token = process.env.META_WHATSAPP_TOKEN;
  if (!token) throw new Error('META_WHATSAPP_TOKEN não configurado no servidor.');
  const pin = String(Math.floor(100000 + Math.random() * 900000));
  return chamar('POST', `/${phoneNumberId}/register`, {
    token,
    body: { messaging_product: 'whatsapp', pin },
  });
}

// Dados públicos do número (status ao vivo — ver GET /crm/api/whatsapp/status).
async function buscarInfoNumero(phoneNumberId) {
  const token = process.env.META_WHATSAPP_TOKEN;
  if (!token) throw new Error('META_WHATSAPP_TOKEN não configurado no servidor.');
  return chamar('GET', `/${phoneNumberId}`, { token, query: { fields: 'display_phone_number,verified_name,quality_rating' } });
}

module.exports = {
  trocarCodePorToken,
  assinarWebhooks,
  atribuirUsuarioSistema,
  registrarNumero,
  buscarInfoNumero,
};
