// Roda casos de avaliação pelo executor real do agente (mesmo código de produção)
// contra um tenant descartável no banco. Modelo falso (mock) por padrão; o modelo
// real só entra com real=true (flag --real do CLI) e ANTHROPIC_API_KEY.
const crypto = require('crypto');
const { semearAgente } = require('../lib/agente/seed');
const { executarTurno, criarClienteAnthropic } = require('../lib/agente/executor');
const { encontrarOuCriarPorTelefone } = require('../lib/clientes');
const { avaliarCaso } = require('./avaliar');

const DENTRO_DO_HORARIO = new Date('2026-10-12T15:00:00Z'); // segunda, 12:00 em São Paulo
const FORA_DO_HORARIO = new Date('2026-10-12T22:00:00Z'); // segunda, 19:00 em São Paulo

const TABELAS_LIMPEZA = ['crm_handoffs', 'crm_agente_execucoes', 'crm_eventos', 'crm_anexos', 'crm_pedidos', 'crm_tags', 'crm_mensagens_whatsapp',
  'crm_conversas_whatsapp', 'crm_clientes', 'crm_etapas', 'crm_agente_conhecimento', 'crm_agente_config', 'crm_campos_customizados',
  'crm_leads', 'crm_leads_etapas', 'crm_chamados'];

async function prepararTenant(pool, { seed, conhecimento }) {
  const tenantId = crypto.randomUUID();
  await semearAgente(pool, tenantId, seed, { modo: 'rascunho', conhecimento });
  await pool.query("insert into crm_etapas (tenant_id, nome, ordem, tipo, fixa) values ($1, 'A fazer', 1, 'aberta', true)", [tenantId]);
  return tenantId;
}

async function limparTenant(pool, tenantId) {
  await pool.query('delete from crm_clientes_tags where cliente_id in (select id from crm_clientes where tenant_id = $1)', [tenantId]);
  for (const t of TABELAS_LIMPEZA) await pool.query(`delete from ${t} where tenant_id = $1`, [tenantId]);
}

let seq = 0;
async function montarCaso(pool, tenantId, caso) {
  const setup = caso.setup || {};
  const fone = `+5534966${String(10000 + (seq += 1))}`;
  const { rows: [conversa0] } = await pool.query(
    `insert into crm_conversas_whatsapp (tenant_id, telefone_e164, estado, situacao, ultima_msg_cliente_em, janela_expira_em, nome_whatsapp)
     values ($1, $2, 'agente', 'bot', now(), now() + interval '24 hours', $3) returning *`, [tenantId, fone, setup.cliente_nome || null]);

  if (setup.cliente_nome || setup.vip) {
    const cliente = await encontrarOuCriarPorTelefone(pool, tenantId, { telefone: fone, nome: setup.cliente_nome || 'Cliente VIP', origem: 'WhatsApp' });
    await pool.query('update crm_conversas_whatsapp set cliente_id = $2 where id = $1', [conversa0.id, cliente.id]);
    if (setup.vip) {
      const { rows: [tag] } = await pool.query(
        "insert into crm_tags (tenant_id, nome) values ($1, 'VIP') on conflict (tenant_id, nome) do update set nome = excluded.nome returning id", [tenantId]);
      await pool.query('insert into crm_clientes_tags (cliente_id, tag_id) values ($1, $2) on conflict do nothing', [cliente.id, tag.id]);
    }
  }

  const insere = async (m, dir, autor, anexoId = null, tipo = 'texto') => {
    const { rows: [msg] } = await pool.query(
      `insert into crm_mensagens_whatsapp (tenant_id, telefone_e164, direcao, tipo, conteudo, wamid, autor, anexo_id, processada_em)
       values ($1, $2, $3, $4, $5, $6, $7, $8, case when $3 = 'enviada' then now() else null end) returning *`,
      [tenantId, fone, dir, tipo, m, `wamid.${crypto.randomUUID()}`, autor, anexoId]);
    return msg;
  };
  for (const h of setup.historico || []) {
    await insere(h.texto, h.de === 'cliente' ? 'recebida' : 'enviada', h.de === 'cliente' ? 'cliente' : 'agente');
  }
  const mensagens = [];
  for (const m of caso.mensagens) {
    let anexoId = null;
    if (m.anexo) {
      const { rows: [a] } = await pool.query(
        `insert into crm_anexos (tenant_id, chave_armazenamento, nome_arquivo, mime, tamanho) values ($1, $2, $3, $4, 1024) returning id`,
        [tenantId, `${tenantId}/eval/${crypto.randomUUID()}-${m.anexo.nome}`, m.anexo.nome, m.anexo.mime]);
      anexoId = a.id;
    }
    mensagens.push(await insere(m.texto, 'recebida', 'cliente', anexoId, m.tipo || 'texto'));
  }
  const { rows: [conversa] } = await pool.query('select * from crm_conversas_whatsapp where id = $1', [conversa0.id]);
  return { conversa, mensagens };
}

async function coletarFatos(pool, tenantId, conversaId) {
  const { rows: [conversa] } = await pool.query('select cliente_id from crm_conversas_whatsapp where tenant_id = $1 and id = $2', [tenantId, conversaId]);
  const { rows: [handoff] } = await pool.query("select motivo, eh_vip, status from crm_handoffs where tenant_id = $1 and conversa_id = $2 order by criado_em desc limit 1", [tenantId, conversaId]);
  let pedido = null;
  if (conversa && conversa.cliente_id) {
    const { rows: [p] } = await pool.query('select * from crm_pedidos where tenant_id = $1 and cliente_id = $2 and rascunho order by criado_em desc limit 1', [tenantId, conversa.cliente_id]);
    if (p) {
      const { rows: vals } = await pool.query(
        'select c.chave, v.valor from crm_pedidos_valores v join crm_campos_customizados c on c.id = v.campo_id where v.pedido_id = $1', [p.id]);
      const { rows: [it] } = await pool.query('select quantidade from crm_pedidos_itens where pedido_id = $1 limit 1', [p.id]);
      const { rows: [an] } = await pool.query('select count(*)::int as n from crm_anexos where tenant_id = $1 and pedido_id = $2', [tenantId, p.id]);
      pedido = {
        origem: p.origem, identificador_externo: p.identificador_externo, aguardando_conferencia: p.aguardando_conferencia,
        quantidade: it ? Number(it.quantidade) : null, anexos: an.n, campos: Object.fromEntries(vals.map((v) => [v.chave, v.valor])),
      };
    }
  }
  return { handoff: handoff || null, pedido };
}

function iaFalsa(respostas) {
  let i = 0;
  return {
    chamadas: 0,
    async criarMensagem() {
      this.chamadas += 1;
      const r = respostas[i];
      i += 1;
      if (!r) throw new Error('roteiro do modelo falso acabou antes do fim do turno');
      return { usage: { input_tokens: 0, output_tokens: 0 }, ...r };
    },
  };
}

// Atalhos para escrever roteiros nos JSON: {"ferramenta": "nome", "input": {…}} ou {"texto": "…"}.
function expandirMock(roteiro) {
  return roteiro.map((p, n) => (p.texto !== undefined
    ? { stop_reason: 'end_turn', content: [{ type: 'text', text: p.texto }], usage: { input_tokens: 150, output_tokens: 40 } }
    : { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `tu_${n}`, name: p.ferramenta, input: p.input || {} }], usage: { input_tokens: 150, output_tokens: 20 } }));
}

async function executarCaso({ pool, tenantId, caso, real, ia, config }) {
  const montado = await montarCaso(pool, tenantId, caso);
  const modelo = real ? ia : iaFalsa(expandirMock(caso.mock));
  const agora = (caso.setup || {}).foraHorario ? FORA_DO_HORARIO : DENTRO_DO_HORARIO;
  let chamadasAoModelo = 0;
  const envolto = { criarMensagem: async (p) => { chamadasAoModelo += 1; return modelo.criarMensagem(p); } };
  const t0 = Date.now();
  const r = await executarTurno({ pool, tenantId, conversa: montado.conversa, mensagens: montado.mensagens },
    { ia: envolto, agora: () => agora, enviarTexto: async () => true, log: () => {} });
  const fatos = await coletarFatos(pool, tenantId, montado.conversa.id);
  let tokens = { in: 0, out: 0 };
  let original = null;
  let motivoBloqueio = null;
  if (r.execucaoId) {
    const { rows: [e] } = await pool.query('select tokens_in, tokens_out, resposta_original, motivo_bloqueio from crm_agente_execucoes where id = $1', [r.execucaoId]);
    tokens = { in: e.tokens_in || 0, out: e.tokens_out || 0 };
    original = e.resposta_original; motivoBloqueio = e.motivo_bloqueio;
  }
  const nomes = (r.ferramentas || []).map((f) => f.nome);
  const resultado = {
    resposta: r.resposta, original, motivoBloqueio, bloqueada: !!r.bloqueada, ferramentas: r.ferramentas || [], chamadasAoModelo, tokens, latenciaMs: Date.now() - t0,
    vipConfirmado: !!(caso.setup || {}).vip && nomes.includes('consultar_cliente_vip'), ...fatos,
  };
  const esperado = real ? caso.esperado : { ...caso.esperado, ...(caso.esperado_mock || {}) };
  return { resultado, falhas: avaliarCaso(esperado, resultado, { textos: config.textos }) };
}

// modelos: lista de ids (só no modo real); no mock roda uma vez com o modelo da config.
async function executarSuite({ pool, casos, modelos = [null], real = false, seed, conhecimento, onCaso = () => {} }) {
  const saida = [];
  const tenants = [];
  try {
    for (const modelo of modelos) {
      // tenant novo por modelo: dados de um (ex.: ID Shopee já registrado) não podem afetar o outro
      const tenantId = await prepararTenant(pool, { seed, conhecimento });
      tenants.push(tenantId);
      if (modelo) await pool.query('update crm_agente_config set modelo_runtime = $2 where tenant_id = $1', [tenantId, modelo]);
      const { rows: [config] } = await pool.query('select * from crm_agente_config where tenant_id = $1', [tenantId]);
      const ia = real ? await criarClienteAnthropic() : null;
      for (const caso of casos) {
        if (real && caso.somente_mock) { saida.push({ modelo: config.modelo_runtime, caso, pulado: 'somente mock' }); continue; }
        if (!real && !caso.mock) { saida.push({ modelo: config.modelo_runtime, caso, pulado: 'sem mock (só roda no modo real)' }); continue; }
        let item;
        try {
          item = { modelo: config.modelo_runtime, caso, ...(await executarCaso({ pool, tenantId, caso, real, ia, config })) };
        } catch (e) {
          item = { modelo: config.modelo_runtime, caso, falhas: [`erro de execução: ${e.message}`], resultado: null };
        }
        saida.push(item);
        onCaso(item);
      }
    }
  } finally {
    for (const t of tenants) await limparTenant(pool, t);
  }
  return saida;
}

module.exports = { executarSuite, executarCaso, prepararTenant, limparTenant, expandirMock, DENTRO_DO_HORARIO, FORA_DO_HORARIO };
