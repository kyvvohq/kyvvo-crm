// Fachada do agente para o index.js: recebe o webhook (rápido), dispara o
// processamento em segundo plano e mantém a varredura periódica.
const path = require('path');
const { receberWebhook } = require('./recebimento');
const { processarConversa, varrerPendentes } = require('./processador');
const { executarTurno } = require('./executor');
const { expurgarLogs } = require('./retencao');
const { criarArmazenamentoDisco } = require('../armazenamento');
const { baixarMidia, DIR_UPLOADS } = require('../whatsapp-media');

function criarAgente(pool, overrides = {}) {
  const deps = {
    baixarMidia,
    armazenamento: criarArmazenamentoDisco(path.join(DIR_UPLOADS, 'agente')),
    log: (m) => console.error(m),
    agora: () => new Date(),
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

  // Expurgo de logs conforme a retenção definida por conta (nada é apagado enquanto retencao_logs_dias for nulo).
  function iniciarRetencao(intervaloMs = 6 * 60 * 60 * 1000) {
    const rodar = () => expurgarLogs(pool).then((r) => r.length && deps.log('[agente] logs expurgados: ' + JSON.stringify(r))).catch((e) => deps.log('[agente] retenção: ' + e.message));
    const t = setInterval(rodar, intervaloMs);
    t.unref();
    return t;
  }

  return { tratarWebhook, iniciarVarredura, iniciarRetencao, deps };
}

module.exports = { criarAgente };
