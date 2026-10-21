// Funil de vendas (Lead) — hoje usado só pelo tenant da própria Kyvvo
// (bot de atendimento geral/suporte/vendas, ver lib/agente/ferramentas-kyvvo.js),
// mas é uma feature genérica do produto: qualquer tenant pode ter seu
// próprio funil de Leads, independente do funil de pedidos. Mesmo molde de
// lib/etapas.js/lib/pedidos.js (etapas padrão + "etapa aberta" + CRUD fino).
const ETAPAS_PADRAO_LEADS_KYVVO = [
  { nome: 'Novo lead', tipo: 'aberta', fixa: true },
  { nome: 'Qualificando', tipo: 'aberta' },
  { nome: 'Proposta enviada', tipo: 'aberta' },
  { nome: 'Ganho', tipo: 'ganha' },
  { nome: 'Perdido', tipo: 'perdida' },
];

// Idempotente: não faz nada se o tenant já tiver etapas de lead.
async function inicializarEtapasLeads(pool, tenantId, etapas = ETAPAS_PADRAO_LEADS_KYVVO) {
  const { rows } = await pool.query('select 1 from crm_leads_etapas where tenant_id = $1 limit 1', [tenantId]);
  if (rows.length > 0) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < etapas.length; i++) {
      const etapa = etapas[i];
      await client.query(
        `insert into crm_leads_etapas (tenant_id, nome, ordem, tipo, fixa) values ($1, $2, $3, $4, $5)`,
        [tenantId, etapa.nome, i, etapa.tipo, !!etapa.fixa]
      );
    }
    await client.query('COMMIT');
  } catch (erro) {
    await client.query('ROLLBACK');
    throw erro;
  } finally {
    client.release();
  }
}

async function listarEtapasLeads(pool, tenantId) {
  const { rows } = await pool.query('select * from crm_leads_etapas where tenant_id = $1 order by ordem', [tenantId]);
  return rows;
}

async function etapaInicialLead(pool, tenantId) {
  const { rows } = await pool.query('select id from crm_leads_etapas where tenant_id = $1 and fixa = true limit 1', [tenantId]);
  return rows[0] ? rows[0].id : null;
}

// Um lead "aberto" por cliente por vez (mesma regra de garantirPedidoRascunho
// pra pedido rascunho) — se já existir um em etapa tipo 'aberta', devolve
// ele; senão cria na etapa inicial fixa.
async function garantirLeadAberto(pool, { tenantId, clienteId, origem, origemConversaId }) {
  const { rows } = await pool.query(
    `select l.* from crm_leads l join crm_leads_etapas e on e.id = l.etapa_id
      where l.tenant_id = $1 and l.cliente_id = $2 and e.tipo = 'aberta'
      order by l.criado_em desc limit 1`,
    [tenantId, clienteId]
  );
  if (rows[0]) return rows[0];

  const etapaId = await etapaInicialLead(pool, tenantId);
  if (!etapaId) throw new Error('conta sem etapa inicial de lead configurada');
  const { rows: [lead] } = await pool.query(
    `insert into crm_leads (tenant_id, cliente_id, etapa_id, origem, origem_conversa_id)
     values ($1, $2, $3, $4, $5) returning *`,
    [tenantId, clienteId, etapaId, origem || 'WhatsApp', origemConversaId || null]
  );
  return lead;
}

async function listarLeads(pool, tenantId, { etapaId, aberto } = {}) {
  const condicoes = ['l.tenant_id = $1'];
  const params = [tenantId];
  if (etapaId) { params.push(etapaId); condicoes.push(`l.etapa_id = $${params.length}`); }
  if (aberto === true) condicoes.push(`e.tipo = 'aberta'`);
  if (aberto === false) condicoes.push(`e.tipo <> 'aberta'`);
  const { rows } = await pool.query(
    `select l.*, c.nome as cliente_nome, c.telefone as cliente_telefone, e.nome as etapa_nome, e.tipo as etapa_tipo
       from crm_leads l
       join crm_clientes c on c.id = l.cliente_id
       join crm_leads_etapas e on e.id = l.etapa_id
      where ${condicoes.join(' and ')}
      order by l.criado_em desc`,
    params
  );
  return rows;
}

async function obterLead(pool, tenantId, id) {
  const { rows } = await pool.query(
    `select l.*, c.nome as cliente_nome, c.telefone as cliente_telefone, e.nome as etapa_nome, e.tipo as etapa_tipo
       from crm_leads l
       join crm_clientes c on c.id = l.cliente_id
       join crm_leads_etapas e on e.id = l.etapa_id
      where l.tenant_id = $1 and l.id = $2`,
    [tenantId, id]
  );
  return rows[0] || null;
}

async function atualizarLead(pool, tenantId, id, { valorEstimado, observacoes, empresa, produtoInteresse, segmento, porte, planoInteresse } = {}) {
  const { rows } = await pool.query(
    `update crm_leads set
       valor_estimado = coalesce($3, valor_estimado),
       observacoes = coalesce($4, observacoes),
       empresa = coalesce($5, empresa),
       produto_interesse = coalesce($6, produto_interesse),
       segmento = coalesce($7, segmento),
       porte = coalesce($8, porte),
       plano_interesse = coalesce($9, plano_interesse),
       atualizado_em = now()
     where tenant_id = $1 and id = $2
     returning *`,
    [tenantId, id, valorEstimado ?? null, observacoes ?? null, empresa ?? null, produtoInteresse ?? null, segmento ?? null, porte ?? null, planoInteresse ?? null]
  );
  return rows[0] || null;
}

async function moverEtapaLead(pool, tenantId, id, etapaId, { motivoPerda } = {}) {
  const { rows } = await pool.query(
    `update crm_leads set etapa_id = $3, motivo_perda = $4, atualizado_em = now()
     where tenant_id = $1 and id = $2
     returning *`,
    [tenantId, id, etapaId, motivoPerda || null]
  );
  return rows[0] || null;
}

// CRUD de etapas de lead — mesmo molde de lib/etapas.js/index.js (etapas de
// pedido), simplificado (sem prazo_alerta_dias/eh_pronto, que são conceitos
// de produção, não de funil de vendas).
async function criarEtapaLead(pool, tenantId, nome) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: etapas } = await client.query('select id, tipo from crm_leads_etapas where tenant_id = $1 order by ordem', [tenantId]);
    const indice = etapas.findIndex((e) => e.tipo !== 'aberta');
    const posicao = indice === -1 ? etapas.length : indice;
    for (let i = etapas.length - 1; i >= posicao; i--) {
      await client.query('update crm_leads_etapas set ordem = $1 where id = $2', [i + 1, etapas[i].id]);
    }
    const { rows } = await client.query(
      `insert into crm_leads_etapas (tenant_id, nome, ordem, tipo) values ($1, $2, $3, 'aberta') returning *`,
      [tenantId, nome, posicao]
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (erro) {
    await client.query('ROLLBACK');
    throw erro;
  } finally {
    client.release();
  }
}

async function renomearEtapaLead(pool, tenantId, id, nome) {
  const { rows } = await pool.query(
    'update crm_leads_etapas set nome = $3 where id = $1 and tenant_id = $2 returning *',
    [id, tenantId, nome]
  );
  return rows[0] || null;
}

async function apagarEtapaLead(pool, tenantId, id) {
  const { rows: alvo } = await pool.query('select fixa from crm_leads_etapas where id = $1 and tenant_id = $2', [id, tenantId]);
  if (!alvo[0]) return { status: 404, erro: 'Etapa não encontrada' };
  if (alvo[0].fixa) return { status: 400, erro: 'Esta é a etapa fixa de entrada e não pode ser apagada.' };
  const { rows: contagem } = await pool.query('select count(*)::int as total from crm_leads where etapa_id = $1 and tenant_id = $2', [id, tenantId]);
  if (contagem[0].total > 0) return { status: 409, erro: `Mova ${contagem[0].total} lead(s) desta etapa antes de apagá-la.` };
  const { rowCount } = await pool.query('delete from crm_leads_etapas where id = $1 and tenant_id = $2', [id, tenantId]);
  return rowCount ? { ok: true } : { status: 404, erro: 'Etapa não encontrada' };
}

async function reordenarEtapasLeads(pool, tenantId, ids) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < ids.length; i++) {
      await client.query('update crm_leads_etapas set ordem = $1 where id = $2 and tenant_id = $3', [i, ids[i], tenantId]);
    }
    await client.query('COMMIT');
  } catch (erro) {
    await client.query('ROLLBACK');
    throw erro;
  } finally {
    client.release();
  }
}

module.exports = {
  ETAPAS_PADRAO_LEADS_KYVVO, inicializarEtapasLeads, listarEtapasLeads, etapaInicialLead,
  garantirLeadAberto, listarLeads, obterLead, atualizarLead, moverEtapaLead,
  criarEtapaLead, renomearEtapaLead, apagarEtapaLead, reordenarEtapasLeads,
};
