// Reexport puro de @kyvvohq/agente-core (fase 1 de padronizar o Atendimento
// entre produtos Kyvvo, 2026-10-14) — parsing de webhook da Meta, 100% puro,
// sem mudança de comportamento.
const { extrairMudancas, normalizarMensagem, tipoNormalizado } = require('@kyvvohq/agente-core');
module.exports = { extrairMudancas, normalizarMensagem, tipoNormalizado };
