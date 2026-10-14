// Reexport puro de @kyvvohq/agente-core (fase 1 de padronizar o Atendimento
// entre produtos Kyvvo, 2026-10-14) — tabela de preço da Anthropic,
// compartilhada entre consumidores do pacote, sem mudança de comportamento.
const { PRECOS_USD_POR_MTOK, custoUsd } = require('@kyvvohq/agente-core');
module.exports = { PRECOS_USD_POR_MTOK, custoUsd };
