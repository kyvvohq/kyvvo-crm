// Fachada do agente para o index.js: recebe o webhook (rápido), dispara o
// processamento em segundo plano e mantém a varredura periódica.
const path = require('path');
const { receberWebhook } = require('./recebimento');
const { processarConversa, varrerPendentes } = require('./processador');
const { executarTurno } = require('./executor');
const { expurgarLogs } = require('./retencao');
const { criarArmazenamentoDisco } = require('../armazenamento');
const { baixarMidia, DIR_UPLOADS } = require('../whatsapp-media');
const { enviarTexto } = require('@kyvvohq/whatsapp');

function criarAgente(pool, overrides = {}) {
  const deps = {
    baixarMidia,
    armazenamento: criarArmazenamentoDisco(path.join(DIR_UPLOADS, 'agente')),
    log: (m) => console.error(m),
    agora: () => new Date(),
    enviarTexto,
    ...overrides,
  };
  // Ponto de entrada do agente; testes injetam `ia` (cliente do modelo) e `enviarTexto`.
  if (!deps.executarAgente) deps.executarAgente = (turno) => executarTurno(turno, { ia: deps.ia, enviarTexto: deps.enviarTexto, agora: deps.agora, log: deps.log });

  // Atraso de resposta por conta (pedido do Bruno, 2026-10-14): algumas
  // contas preferem não responder na hora, pra não parecer um robô
  // respondendo instantaneamente. `limites.delay_resposta_segundos` vem do
  // seed de cada conta (db/seeds/*.json); sem essa chave, comportamento
  // igual a antes (responde na hora). Quem efetivamente processa depois do
  // atraso é a varredura periódica (iniciarVarredura), que já existia pra
  // recuperar mensagem perdida entre o 200 do webhook e o processamento.
  async function atrasoRespostaSegundos(tenantId) {
    const { rows: [c] } = await pool.query('select limites from crm_agente_config where tenant_id = $1', [tenantId]);
    return Number((c && c.limites && c.limites.delay_resposta_segundos) || 0);
  }

  // Responde rápido: grava e devolve; `processamentos` roda solto (o handler não espera).
  async function tratarWebhook(body) {
    const { tratados, novas } = await receberWebhook(pool, body, { agora: deps.agora });
    const vistos = new Set();
    const processamentos = [];
    for (const n of novas) {
      if (vistos.has(n.conversaId)) continue;
      vistos.add(n.conversaId);
      if (await atrasoRespostaSegundos(n.tenantId)) continue; // a varredura periódica processa depois do atraso configurado
      processamentos.push(
        processarConversa(pool, n.tenantId, n.conversaId, deps).catch((e) => deps.log(`[agente] ${e.message}`)),
      );
    }
    return { tratados, processamentos };
  }

  // esperaSegundos também é o atraso de resposta das contas com
  // `delay_resposta_segundos` configurado (ver atrasoRespostaSegundos acima)
  // — contas sem essa chave nunca chegam a ficar pendentes até aqui, porque
  // já foram processadas na hora em tratarWebhook.
  function iniciarVarredura(intervaloMs = 60000, varrerOpts = { esperaSegundos: 240 }) {
    const t = setInterval(() => varrerPendentes(pool, deps, varrerOpts).catch((e) => deps.log(`[agente] varredura: ${e.message}`)), intervaloMs);
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
