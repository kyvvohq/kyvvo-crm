// Um turno do agente: contexto -> modelo (com ferramentas) -> pós-filtro ->
// rascunho ou envio. Wrapper fininho de @kyvvohq/agente-core (fase 1 de
// padronizar o Atendimento entre produtos Kyvvo, 2026-10-14) — monta os
// plug-ins de domínio do CRM (ferramentas, contexto dinâmico, pós-filtro,
// gatilhos) e delega o loop pro pacote. Mantém a assinatura pública
// idêntica (`executarTurno`, `criarClienteAnthropic`, `MAX_ITERACOES`).
const agenteCore = require('./nucleo');
const { FERRAMENTAS, executarFerramenta, anexarMidia, transferirParaEquipe } = require('./ferramentas');
const { PADROES } = require('./posfiltro');
const { blocoDinamico } = require('./contexto');
const { GATILHOS, COMERCIAL, extrairIdShopee } = require('./gatilhos');

const MAX_ITERACOES = 4;

async function criarClienteAnthropic() {
  const Anthropic = require('@anthropic-ai/sdk');
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY não configurada');
  const client = new Anthropic();
  return { criarMensagem: (params) => client.messages.create(params) };
}

async function briefingMinimoExistente(pool, { tenantId, clienteId }) {
  const { rows } = await pool.query(
    "select 1 from crm_pedidos p join crm_pedidos_itens i on i.pedido_id = p.id where p.tenant_id = $1 and p.cliente_id = $2 and p.rascunho limit 1",
    [tenantId, clienteId],
  );
  return rows.length > 0;
}

async function executarTurno({ pool, tenantId, conversa, mensagens }, deps = {}) {
  const agora = deps.agora;
  const enviarTexto = deps.enviarTexto;
  const log = deps.log;
  const ia = deps.ia;

  return agenteCore.executarTurno({ pool, tenantId, conversa, mensagens }, {
    agora, enviarTexto, log, ia,
    ferramentas: { FERRAMENTAS, executarFerramenta, anexarMidia, transferirParaEquipe },
    blocoDinamico,
    // Repassado pro carregarHistorico interno do pacote — sem isto, o
    // histórico mandado ao modelo usa o rótulo genérico de anexo ("recebido
    // e anexado"), não o do CRM ("...ao pedido").
    contexto: { rotuloAnexo: 'recebido e anexado ao pedido' },
    posfiltro: { padroes: PADROES },
    gatilhos: {
      padroes: GATILHOS,
      comercial: COMERCIAL,
      suprimirSeVip: ['negociacao_desconto'],
      motivoComercial: 'pergunta_valor_prazo_frete_pagamento',
      briefingMinimoExistente,
      extras: [{ ferramenta: 'registrar_id_shopee', extrair: extrairIdShopee, montarInput: (v) => ({ id_pedido: v }) }],
    },
  });
}

module.exports = { executarTurno, criarClienteAnthropic, MAX_ITERACOES };
