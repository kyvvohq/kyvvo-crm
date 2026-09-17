const { paraE164 } = require('./telefone');

// Cria pedido precisa achar-ou-criar o cliente na hora (seção 7.2 do doc:
// "Criar pedido cria o cliente na hora se ele não existir"). Telefone é a
// chave de identidade (seção 6) — normalizado pra E.164 antes de comparar.
async function encontrarOuCriarPorTelefone(pool, tenantId, { telefone, nome, origem }) {
  const telefoneE164 = paraE164(telefone);
  if (!telefoneE164) {
    // Cliente "sem contato" (seção 6): sempre cria um novo, não há como
    // deduplicar sem telefone nem CPF neste fluxo rápido do kanban.
    const { rows } = await pool.query(
      `insert into crm_clientes (tenant_id, nome, origem) values ($1, $2, $3) returning *`,
      [tenantId, nome || 'Sem nome', origem || null]
    );
    return rows[0];
  }

  const existente = await pool.query(
    `select * from crm_clientes where tenant_id = $1 and telefone = $2`,
    [tenantId, telefoneE164]
  );
  if (existente.rows[0]) return existente.rows[0];

  const { rows } = await pool.query(
    `insert into crm_clientes (tenant_id, nome, telefone, origem) values ($1, $2, $3, $4) returning *`,
    [tenantId, nome || 'Sem nome', telefoneE164, origem || null]
  );
  return rows[0];
}

// Métricas calculadas (seção 6: "nunca digitadas"). "Compra" = pedido em
// etapa tipo 'ganha' (produção concluída/entregue) — pedido só em etapa
// aberta ainda não conta como venda fechada.
async function buscarMetricas(pool, clienteId) {
  const { rows } = await pool.query(
    `select
       count(*) filter (where et.tipo = 'ganha')::int as quantidade_pedidos,
       coalesce(sum(p.valor_recebido) filter (where et.tipo = 'ganha'), 0) as total_gasto,
       max(p.criado_em) filter (where et.tipo = 'ganha') as ultimo_pedido_em
     from crm_pedidos p
     join crm_etapas et on et.id = p.etapa_id
     where p.cliente_id = $1`,
    [clienteId]
  );
  const linha = rows[0];
  const quantidade = linha.quantidade_pedidos;
  const totalGasto = Number(linha.total_gasto);
  const ticketMedio = quantidade > 0 ? totalGasto / quantidade : 0;
  const diasSemComprar = linha.ultimo_pedido_em
    ? Math.floor((Date.now() - new Date(linha.ultimo_pedido_em).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  return {
    quantidade_pedidos: quantidade,
    total_gasto: totalGasto,
    ticket_medio: ticketMedio,
    ultimo_pedido_em: linha.ultimo_pedido_em,
    dias_sem_comprar: diasSemComprar,
  };
}

module.exports = { encontrarOuCriarPorTelefone, buscarMetricas };
