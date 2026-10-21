// Chamado (suporte) — workflow de status simples (não um funil configurável
// como Lead, ver lib/leads.js). Hoje usado só pelo tenant da própria Kyvvo.
const CATEGORIAS_VALIDAS = ['bug', 'duvida_tecnica', 'reclamacao', 'outro'];
const URGENCIAS_VALIDAS = ['baixa', 'media', 'alta', 'critica'];
const STATUS_VALIDOS = ['aberto', 'em_andamento', 'aguardando_cliente', 'resolvido', 'fechado'];

async function criarChamado(pool, { tenantId, clienteId, origem, origemConversaId, categoria, descricao, produtoAfetado, urgencia }) {
  if (!descricao || !descricao.trim()) throw new Error('descricao é obrigatória');
  const categoriaFinal = CATEGORIAS_VALIDAS.includes(categoria) ? categoria : 'outro';
  const urgenciaFinal = URGENCIAS_VALIDAS.includes(urgencia) ? urgencia : 'media';
  const { rows: [chamado] } = await pool.query(
    `insert into crm_chamados (tenant_id, cliente_id, origem, origem_conversa_id, categoria, descricao, produto_afetado, urgencia)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
    [tenantId, clienteId, origem || 'WhatsApp', origemConversaId || null, categoriaFinal, descricao.trim(), produtoAfetado || null, urgenciaFinal]
  );
  return chamado;
}

async function listarChamados(pool, tenantId, { status, urgencia } = {}) {
  const condicoes = ['ch.tenant_id = $1'];
  const params = [tenantId];
  if (status) { params.push(status); condicoes.push(`ch.status = $${params.length}`); }
  if (urgencia) { params.push(urgencia); condicoes.push(`ch.urgencia = $${params.length}`); }
  const { rows } = await pool.query(
    `select ch.*, c.nome as cliente_nome, c.telefone as cliente_telefone
       from crm_chamados ch join crm_clientes c on c.id = ch.cliente_id
      where ${condicoes.join(' and ')}
      order by (ch.status in ('resolvido', 'fechado')), ch.criado_em desc`,
    params
  );
  return rows;
}

async function obterChamado(pool, tenantId, id) {
  const { rows } = await pool.query(
    `select ch.*, c.nome as cliente_nome, c.telefone as cliente_telefone
       from crm_chamados ch join crm_clientes c on c.id = ch.cliente_id
      where ch.tenant_id = $1 and ch.id = $2`,
    [tenantId, id]
  );
  return rows[0] || null;
}

// `resolucaoResumo` só é gravado quando informado; `resolvido_em` é setado
// automaticamente ao entrar em 'resolvido'/'fechado' pela primeira vez (não
// reseta se já tinha, pra manter o timestamp da primeira resolução).
async function atualizarStatusChamado(pool, tenantId, id, { status, resolucaoResumo } = {}) {
  if (status && !STATUS_VALIDOS.includes(status)) throw new Error(`status inválido: ${status}`);
  const resolvendoAgora = status === 'resolvido' || status === 'fechado';
  const { rows } = await pool.query(
    `update crm_chamados set
       status = coalesce($3, status),
       resolucao_resumo = coalesce($4, resolucao_resumo),
       resolvido_em = case when $5 and resolvido_em is null then now() else resolvido_em end,
       atualizado_em = now()
     where tenant_id = $1 and id = $2
     returning *`,
    [tenantId, id, status || null, resolucaoResumo || null, resolvendoAgora]
  );
  return rows[0] || null;
}

module.exports = {
  CATEGORIAS_VALIDAS, URGENCIAS_VALIDAS, STATUS_VALIDOS,
  criarChamado, listarChamados, obterChamado, atualizarStatusChamado,
};
