// Fachada do agente para o index.js: recebe o webhook (rápido), dispara o
// processamento em segundo plano e mantém a varredura periódica.
const path = require('path');
const { receberWebhook } = require('./recebimento');
const { processarConversa, varrerPendentes } = require('./processador');
const { executarTurno } = require('./executor');
const { criarArmazenamentoDisco } = require('../armazenamento');
const { baixarMidia, DIR_UPLOADS } = require('../whatsapp-media');

function criarAgente(pool, overrides = {}) {
  const deps = {
    baixarMidia,
    armazenamento: criarArmazenamentoDisco(path.join(DIR_UPLOADS, 'agente')),
    log: (m) => console.error(m),
    ...overrides,
  };
  // Ponto de entrada do agente; testes injetam `ia` (cliente do modelo) e `enviarTexto`.
  if (!deps.executarAgente) deps.executarAgente = (turno) => executarTurno(turno, { ia: deps.ia, enviarTexto: deps.enviarTexto, agora: deps.agora, log: deps.log });

  // Responde rápido: grava e devolve; `processamentos` roda solto (o handler não espera).
  async function tratarWebhook(body) {
    const { tratados, novas } = await receberWebhook(pool, body, { agora: deps.agora });
    const vistos = new Set();
    const processamentos = [];
    for (const n of novas) {
      if (vistos.has(n.conversaId)) continue;
      vistos.add(n.conversaId);
      processamentos.push(
        processarConversa(pool, n.tenantId, n.conversaId, deps).catch((e) => deps.log(`[agente] ${e.message}`)),
      );
    }
    return { tratados, processamentos };
  }

  function iniciarVarredura(intervaloMs = 60000) {
    const t = setInterval(() => varrerPendentes(pool, deps).catch((e) => deps.log(`[agente] varredura: ${e.message}`)), intervaloMs);
    t.unref();
    return t;
  }

  return { tratarWebhook, iniciarVarredura, deps };
}

module.exports = { criarAgente };
