// Reexport fininho de @kyvvohq/agente-core (fase 1 de padronizar o
// Atendimento entre produtos Kyvvo, 2026-10-14), bindado com as tabelas do
// CRM via lib/agente/nucleo.js.
const agenteCore = require('./nucleo');
module.exports = { expurgarLogs: agenteCore.expurgarLogs };
