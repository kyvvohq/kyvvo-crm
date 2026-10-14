// Atendimento: o que a equipe faz com as conversas do agente — ver,
// aprovar/editar/descartar a sugestão (modo rascunho), assumir, responder,
// devolver ao agente. Wrapper fininho/composto de @kyvvohq/agente-core
// (fase 1 de padronizar o Atendimento entre produtos Kyvvo, 2026-10-14):
// a maioria das funções delega; `obterConversa` compõe `obterConversaBase`
// (do pacote) + o bloco de pedido (100% CRM, o pacote não sabe o que é
// "pedido"); `marcarPedidoRevisado` fica 100% aqui; o log de auditoria
// (`crm_eventos`) é feito aqui, nunca pelo pacote.
const agenteCore = require('./nucleo');

const MOTIVOS_ROTULO = {
  reclamacao: 'Reclamação',
  produto_danificado_ou_diferente: 'Produto danificado ou diferente',
  pedido_humano: 'Pediu para falar com uma pessoa',
  urgencia: 'Urgência',
  negociacao_desconto: 'Desconto ou negociação',
  modelo_complexo: 'Modelo complexo ou incerto',
  pedido_atrasado: 'Pedido atrasado',
  andamento_pedido: 'Andamento do pedido',
  pergunta_valor_prazo_frete_pagamento: 'Quer valor, prazo ou frete',
  nao_entendeu: 'Agente não entendeu',
  vip_nao_confirmado: 'Diz ser VIP (não confirmado)',
  midia_nao_suportada: 'Enviou áudio, vídeo ou figurinha',
  arquivo_recebido: 'Enviou arquivo',
  bloqueio_filtro: 'Resposta do agente bloqueada',
  limite_turnos: 'Dificuldade de compreensão pela IA',
  limite_custo: 'Limite de uso do agente',
  rate_limit: 'Excesso de mensagens da cliente',
  janela_expirada: 'Janela de 24 h expirada',
  falha_agente: 'Falha do agente',
  outro: 'Outro motivo',
};

const { ErroAtendimento } = agenteCore.atendimento;

async function resolverNomesClientes(pool, tenantId, clienteIds) {
  if (!clienteIds.length) return new Map();
  const { rows } = await pool.query('select id, nome from crm_clientes where tenant_id = $1 and id = any($2::uuid[])', [tenantId, clienteIds]);
  return new Map(rows.map((r) => [r.id, r.nome]));
}

async function evento(pool, tenantId, conversa, tipo, userId, dados) {
  await pool.query('insert into crm_eventos (tenant_id, cliente_id, tipo, dados, ator_id) values ($1, $2, $3, $4, $5)',
    [tenantId, conversa.cliente_id, tipo, JSON.stringify(dados || {}), userId || null]);
}

async function listarConversas(pool, tenantId, opts = {}) {
  const rows = await agenteCore.atendimento.listarConversas(pool, tenantId, { ...opts, resolverNomesClientes });
  return rows.map((r) => ({ ...r, handoff_rotulo: r.handoff_motivo ? MOTIVOS_ROTULO[r.handoff_motivo] || r.handoff_motivo : null }));
}

// Compõe obterConversaBase (genérico) + bloco de pedido (100% CRM, igual ao original).
async function obterConversa(pool, tenantId, id) {
  const base = await agenteCore.atendimento.obterConversaBase(pool, tenantId, id, { resolverNomesClientes });
  let pedido = null;
  if (base.conversa.cliente_id) {
    const { rows: [p] } = await pool.query(
      `select p.id, p.numero, p.rascunho, p.origem, p.identificador_externo, p.aguardando_conferencia, p.observacoes
         from crm_pedidos p where p.tenant_id = $1 and p.cliente_id = $2 and p.rascunho order by p.criado_em desc limit 1`, [tenantId, base.conversa.cliente_id]);
    if (p) {
      const { rows: campos } = await pool.query(
        `select cc.label, cc.chave, v.valor from crm_pedidos_valores v join crm_campos_customizados cc on cc.id = v.campo_id
          where v.pedido_id = $1 and cc.tenant_id = $2 order by cc.ordem`, [p.id, tenantId]);
      const { rows: [it] } = await pool.query('select descricao, quantidade from crm_pedidos_itens where pedido_id = $1 limit 1', [p.id]);
      pedido = { ...p, campos, item: it ? { descricao: it.descricao, quantidade: Number(it.quantidade) } : null };
    }
  }
  return {
    ...base,
    handoff: base.handoff ? { ...base.handoff, rotulo: MOTIVOS_ROTULO[base.handoff.motivo] || base.handoff.motivo } : null,
    pedido,
  };
}

async function enviarSugestao(pool, tenantId, userId, execucaoId, texto, deps) {
  const r = await agenteCore.atendimento.enviarSugestao(pool, tenantId, execucaoId, texto, deps);
  await evento(pool, tenantId, { cliente_id: r.clienteId }, 'atendimento_sugestao', userId, { execucao: execucaoId, decisao: r.decisao });
  return { ok: true, decisao: r.decisao };
}

async function descartarSugestao(pool, tenantId, userId, execucaoId) {
  const r = await agenteCore.atendimento.descartarSugestao(pool, tenantId, execucaoId);
  await evento(pool, tenantId, { cliente_id: r.clienteId }, 'atendimento_sugestao', userId, { execucao: execucaoId, decisao: 'descartada' });
  return { ok: true };
}

async function assumir(pool, tenantId, userId, conversaId) {
  const r = await agenteCore.atendimento.assumir(pool, tenantId, userId, conversaId);
  await evento(pool, tenantId, { cliente_id: r.clienteId }, 'atendimento_assumido', userId, {});
  return { ok: true, situacao: r.situacao };
}

async function responderComoHumano(pool, tenantId, userId, conversaId, texto, deps) {
  const r = await agenteCore.atendimento.responderComoHumano(pool, tenantId, userId, conversaId, texto, deps);
  await evento(pool, tenantId, { cliente_id: r.clienteId }, 'atendimento_assumido', userId, {});
  return { ok: true };
}

async function devolverAoAgente(pool, tenantId, userId, conversaId) {
  const r = await agenteCore.atendimento.devolverAoAgente(pool, tenantId, conversaId);
  await evento(pool, tenantId, { cliente_id: r.clienteId }, 'atendimento_devolvido_ao_agente', userId, {});
  return { ok: true, situacao: r.situacao };
}

async function encerrar(pool, tenantId, userId, conversaId) {
  const r = await agenteCore.atendimento.encerrar(pool, tenantId, conversaId);
  await evento(pool, tenantId, { cliente_id: r.clienteId }, 'atendimento_encerrado', userId, {});
  return { ok: true, situacao: r.situacao };
}

async function listarEncaminhamentos(pool, tenantId, limite = 30) {
  const rows = await agenteCore.atendimento.listarEncaminhamentos(pool, tenantId, limite, { resolverNomesClientes });
  return rows.map((r) => ({ ...r, rotulo: MOTIVOS_ROTULO[r.motivo] || r.motivo }));
}

const contarAbertos = agenteCore.atendimento.contarAbertos;
const obterConfig = agenteCore.atendimento.obterConfig;

// Chave de liga/desliga: só o modo. O resto da configuração vem do seed por conta.
async function definirModo(pool, tenantId, userId, modo) {
  const r = await agenteCore.atendimento.definirModo(pool, tenantId, modo);
  await pool.query('insert into crm_eventos (tenant_id, tipo, dados, ator_id) values ($1, $2, $3, $4)', [tenantId, 'agente_modo', JSON.stringify({ modo }), userId || null]);
  return r;
}

// A equipe revisou o rascunho criado pelo agente: vira pedido normal. 100%
// CRM — o pacote não sabe o que é "pedido".
async function marcarPedidoRevisado(pool, tenantId, userId, pedidoId) {
  const { rows: [p] } = await pool.query(
    'update crm_pedidos set rascunho = false, atualizado_em = now() where tenant_id = $1 and id = $2 and rascunho returning id, cliente_id', [tenantId, pedidoId]);
  if (!p) throw new ErroAtendimento(404, 'Pedido rascunho não encontrado');
  await pool.query('insert into crm_eventos (tenant_id, cliente_id, pedido_id, tipo, dados, ator_id) values ($1, $2, $3, $4, $5, $6)',
    [tenantId, p.cliente_id, p.id, 'pedido_revisado', '{}', userId || null]);
  return { ok: true };
}

module.exports = {
  ErroAtendimento, MOTIVOS_ROTULO, listarConversas, obterConversa, enviarSugestao, descartarSugestao, assumir, responderComoHumano,
  devolverAoAgente, encerrar, listarEncaminhamentos, contarAbertos, obterConfig, definirModo, marcarPedidoRevisado,
};
