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

// Perfis de agente por conta (crm_agente_config.perfil_agente, migration
// 049) — ponto de extensão pra tenants com ferramentas/gatilhos/contexto
// diferentes do negócio original (produção sob encomenda/Basic 3D Print).
// O bundle 'basic3d_producao_sob_encomenda' é literalmente o que já existia
// antes deste ponto de extensão — zero mudança de comportamento pra quem já
// usa o agente hoje, inclusive sem backfill (default da coluna já aponta
// pra cá). Fallback pro mesmo bundle se a coluna vier vazia/desconhecida —
// nunca quebra por um valor inesperado.
const PERFIS = {
  basic3d_producao_sob_encomenda: {
    ferramentas: { FERRAMENTAS, executarFerramenta, anexarMidia, transferirParaEquipe },
    blocoDinamico,
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
  },
  get kyvvo_atendimento() { return require('./perfis/kyvvo-atendimento'); }, // lazy: só carrega quem usa
};

async function perfilDoTenant(pool, tenantId) {
  const { rows: [cfg] } = await pool.query('select perfil_agente from crm_agente_config where tenant_id = $1', [tenantId]);
  const chave = cfg && PERFIS[cfg.perfil_agente] ? cfg.perfil_agente : 'basic3d_producao_sob_encomenda';
  return PERFIS[chave];
}

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

  const perfil = await perfilDoTenant(pool, tenantId);
  return agenteCore.executarTurno({ pool, tenantId, conversa, mensagens }, {
    agora, enviarTexto, log, ia,
    ferramentas: perfil.ferramentas,
    blocoDinamico: perfil.blocoDinamico,
    // Repassado pro carregarHistorico interno do pacote — sem isto, o
    // histórico mandado ao modelo usa o rótulo genérico de anexo ("recebido
    // e anexado"), não o rótulo específico do perfil (ex.: "...ao pedido").
    contexto: perfil.contexto,
    posfiltro: perfil.posfiltro,
    gatilhos: perfil.gatilhos,
  });
}

module.exports = { executarTurno, criarClienteAnthropic, MAX_ITERACOES };
