// Ferramentas do agente pro tenant da própria Kyvvo (atendimento geral,
// suporte e vendas num canal só) — bundle alternativo ao de
// lib/agente/ferramentas.js (esse é 100% específico de impressão 3D/Basic
// 3D Print). Mesma regra de segurança: tenant/conversa sempre vêm do
// servidor (ctx.tenantId/ctx.conversaId), nenhuma ferramenta aceita id de
// fora. Selecionado por tenant via crm_agente_config.perfil_agente, ver
// lib/agente/executor.js.
const { garantirCliente } = require('./ferramentas');
const agenteCore = require('./nucleo');
const leads = require('../leads');
const chamados = require('../chamados');

const MOTIVOS_KYVVO = [
  'quer_falar_com_humano', 'reclamacao', 'duvida_tecnica_complexa',
  'pedido_cancelamento', 'interesse_comercial_avancado', 'outro',
];

const PRODUTOS_KYVVO = ['studio', 'crm', 'people', 'platform', 'nao_sabe'];
const PRODUTOS_KYVVO_CHAMADO = ['studio', 'crm', 'people', 'platform', 'outro'];

const FERRAMENTAS_KYVVO = [
  {
    name: 'buscar_ou_criar_cliente',
    description: 'Identifica o contato desta conversa pelo telefone (cria o cadastro se ainda não existir). Chame no início da conversa.',
    input_schema: { type: 'object', properties: { nome: { type: 'string', description: 'Nome do contato, se ele informou' } }, additionalProperties: false },
  },
  {
    name: 'registrar_lead',
    description: 'Registra interesse comercial do contato em algum produto Kyvvo. Chame assim que ficar claro que é uma conversa de vendas, mesmo sem todos os campos ainda — envie só o que já foi coletado, pode chamar de novo depois com mais informação.',
    input_schema: {
      type: 'object',
      properties: {
        empresa: { type: 'string', description: 'Nome da empresa do contato' },
        produto_interesse: { type: 'string', enum: PRODUTOS_KYVVO, description: 'Qual produto Kyvvo (Studio, CRM, People, Platform) desperta interesse' },
        segmento: { type: 'string', description: 'Segmento/ramo da empresa (ex.: salão, loja, recrutamento)' },
        porte: { type: 'string', enum: ['pequeno', 'medio', 'grande'] },
        plano_interesse: { type: 'string', description: 'Plano ou funcionalidade específica mencionada, em texto livre — nunca inclua valor em reais' },
        observacoes: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'abrir_chamado',
    description: 'Abre um chamado de suporte quando o contato relata um problema técnico, bug ou dúvida de uso de algum produto Kyvvo.',
    input_schema: {
      type: 'object',
      properties: {
        categoria: { type: 'string', enum: chamados.CATEGORIAS_VALIDAS },
        descricao: { type: 'string', description: 'Descrição objetiva do problema relatado' },
        produto_afetado: { type: 'string', enum: PRODUTOS_KYVVO_CHAMADO },
        urgencia: { type: 'string', enum: chamados.URGENCIAS_VALIDAS },
      },
      required: ['descricao'],
      additionalProperties: false,
    },
  },
  {
    name: 'transferir_para_equipe',
    description: 'Encaminha a conversa para a equipe Kyvvo, com motivo e um resumo curto do que foi coletado e do que o contato quer.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string', enum: MOTIVOS_KYVVO },
        resumo: { type: 'string', description: 'Resumo objetivo para a equipe, até 600 caracteres' },
      },
      required: ['motivo', 'resumo'],
      additionalProperties: false,
    },
  },
];

function texto(v, max = 500) {
  if (v === undefined || v === null) return undefined;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : undefined;
}

async function evento(pool, ctx, { clienteId = null, leadId = null, chamadoId = null, tipo, dados }) {
  await pool.query(
    'insert into crm_eventos (tenant_id, cliente_id, lead_id, chamado_id, tipo, dados) values ($1, $2, $3, $4, $5, $6)',
    [ctx.tenantId, clienteId, leadId, chamadoId, tipo, JSON.stringify({ ator: 'agente', ...dados })]
  );
}

async function registrarLead(pool, ctx, input) {
  const cliente = await garantirCliente(pool, ctx, texto(input.nome, 120));
  const lead = await leads.garantirLeadAberto(pool, { tenantId: ctx.tenantId, clienteId: cliente.id, origem: 'WhatsApp', origemConversaId: ctx.conversaId });

  const empresa = texto(input.empresa, 120);
  const segmento = texto(input.segmento, 120);
  const planoInteresse = texto(input.plano_interesse, 200);
  const observacoesNovas = texto(input.observacoes, 500);
  const produtoInteresse = PRODUTOS_KYVVO.includes(input.produto_interesse) ? input.produto_interesse : undefined;
  const porte = ['pequeno', 'medio', 'grande'].includes(input.porte) ? input.porte : undefined;

  const campos = {};
  if (produtoInteresse) campos.produto_interesse = produtoInteresse;
  if (segmento) campos.segmento = segmento;
  if (porte) campos.porte = porte;
  if (planoInteresse) campos.plano_interesse = planoInteresse;
  if (empresa) campos.empresa = empresa;

  const observacoesFinais = observacoesNovas
    ? `${lead.observacoes ? `${lead.observacoes}\n` : ''}${observacoesNovas}`
    : undefined;
  const leadAtualizado = await leads.atualizarLead(pool, ctx.tenantId, lead.id, {
    empresa, produtoInteresse, segmento, porte, planoInteresse, observacoes: observacoesFinais,
  });

  ctx.estado.leadId = lead.id;
  await evento(pool, ctx, { clienteId: cliente.id, leadId: lead.id, tipo: 'agente_lead', dados: { campos } });

  return { ok: true, lead_id: leadAtualizado.id, campos_registrados: Object.keys(campos) };
}

async function abrirChamado(pool, ctx, input) {
  const cliente = await garantirCliente(pool, ctx);
  const chamado = await chamados.criarChamado(pool, {
    tenantId: ctx.tenantId, clienteId: cliente.id, origem: 'WhatsApp', origemConversaId: ctx.conversaId,
    categoria: input.categoria, descricao: texto(input.descricao, 1000), produtoAfetado: input.produto_afetado, urgencia: input.urgencia,
  });
  ctx.estado.chamadoId = chamado.id;
  await evento(pool, ctx, { clienteId: cliente.id, chamadoId: chamado.id, tipo: 'agente_chamado', dados: { categoria: chamado.categoria, urgencia: chamado.urgencia } });
  return { ok: true, chamado_id: chamado.id, categoria: chamado.categoria, urgencia: chamado.urgencia };
}

async function transferirParaEquipeKyvvo(pool, ctx, input) {
  const motivo = MOTIVOS_KYVVO.includes(input.motivo) ? input.motivo : 'outro';
  const resumo = texto(input.resumo, 600) || 'Sem resumo.';
  const { rows: [conversa] } = await pool.query(
    'select cliente_id from crm_conversas_whatsapp where tenant_id = $1 and id = $2', [ctx.tenantId, ctx.conversaId]
  );
  const clienteId = (conversa && conversa.cliente_id) || ctx.estado.clienteId || null;

  const dados = {};
  if (ctx.estado.leadId) dados.lead_id = ctx.estado.leadId;
  if (ctx.estado.chamadoId) dados.chamado_id = ctx.estado.chamadoId;

  await agenteCore.gravarHandoff(pool, {
    tenantId: ctx.tenantId, conversaId: ctx.conversaId, clienteId, pedidoId: null, motivo, resumo, dadosColetados: dados, ehVip: false,
  });
  await evento(pool, ctx, { clienteId, tipo: 'agente_handoff', dados: { motivo, resumo } });
  ctx.estado.transferiu = true;
  return { ok: true, observacao: 'Conversa encaminhada. Avise o contato em uma mensagem curta.' };
}

const TABELA_KYVVO = {
  buscar_ou_criar_cliente: async (pool, ctx, input) => {
    const c = await garantirCliente(pool, ctx, texto(input.nome, 120));
    return { ok: true, nome: c.nome === 'Sem nome' ? null : c.nome, cliente_novo: !!(c.criado_em && Date.now() - new Date(c.criado_em).getTime() < 60000) };
  },
  registrar_lead: registrarLead,
  abrir_chamado: abrirChamado,
  transferir_para_equipe: transferirParaEquipeKyvvo,
};

async function executarFerramentaKyvvo(pool, ctx, nome, input) {
  const fn = TABELA_KYVVO[nome];
  if (!fn) throw new Error(`ferramenta desconhecida: ${nome}`);
  return fn(pool, ctx, input && typeof input === 'object' ? input : {});
}

module.exports = {
  FERRAMENTAS_KYVVO, MOTIVOS_KYVVO, executarFerramentaKyvvo, transferirParaEquipeKyvvo,
  // anexarMidia: Kyvvo não anexa mídia a lead/chamado neste v1 (fora de
  // escopo, ver plano) — no-op seguro em vez de reaproveitar o da Basic3D
  // (que anexaria a um pedido que não existe aqui).
  anexarMidia: async () => 0,
};
