// Parte síncrona do webhook do agente. Wrapper fininho de
// @kyvvohq/agente-core (fase 1 de padronizar o Atendimento entre produtos
// Kyvvo, 2026-10-14) — `paraE164` é normalização de telefone própria do
// CRM (cada produto Kyvvo mantém a sua, de propósito não compartilhada).
const { paraE164 } = require('../telefone');
const agenteCore = require('./nucleo');

function receberWebhook(pool, body, opts = {}) {
  return agenteCore.receberWebhook(pool, body, { ...opts, paraE164 });
}

module.exports = { receberWebhook, carregarCanalAtivo: agenteCore.carregarCanalAtivo };
