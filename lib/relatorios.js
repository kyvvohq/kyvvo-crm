// Relatório de pedidos (pedido do Bruno, 2026-10-02) — motor único e
// parametrizável em vez de 6 relatórios hardcoded separados ("valor total
// por período/dia/cliente/tipo de frete/segmento/origem" na real são a
// MESMA consulta, só trocando a coluna de agrupamento) — menos código
// duplicado, e dá pra cruzar qualquer filtro com qualquer agrupamento.
//
// Pedidos com etapa tipo='perdida' (cancelados, ver POST .../cancelar em
// index.js) ficam de fora dos totais sempre — "valor total de pedidos" não
// devia contar venda que não aconteceu. Não é configurável de propósito,
// pra não ter um relatório de "faturamento" que às vezes inclui cancelado
// e às vezes não, dependendo de um filtro que alguém esqueceu de marcar.

const AGRUPAMENTOS = {
  dia: { chave: 'p.criado_em::date', rotulo: null, titulo: 'Dia' },
  cliente: { chave: 'c.id', rotulo: 'c.nome', titulo: 'Cliente' },
  tipo_entrega: { chave: `coalesce(p.tipo_entrega, 'Não informado')`, rotulo: null, titulo: 'Tipo de frete' },
  segmento: { chave: `coalesce(c.segmento, 'Não informado')`, rotulo: null, titulo: 'Segmento' },
  origem: { chave: 'p.origem', rotulo: null, titulo: 'Origem' },
};

function montarFiltro(tenantId, filtros) {
  const { dataInicio, dataFim, tipoEntrega, segmento, origem, etapaId, apenasHoje, proximosEntregaDias } = filtros || {};
  const condicoes = ['p.tenant_id = $1', `e.tipo != 'perdida'`];
  const params = [tenantId];
  if (dataInicio) { params.push(dataInicio); condicoes.push(`p.criado_em >= $${params.length}::date`); }
  if (dataFim) { params.push(dataFim); condicoes.push(`p.criado_em < $${params.length}::date + interval '1 day'`); }
  if (tipoEntrega) { params.push(tipoEntrega); condicoes.push(`p.tipo_entrega = $${params.length}`); }
  if (segmento) { params.push(segmento); condicoes.push(`c.segmento = $${params.length}`); }
  if (origem) { params.push(origem); condicoes.push(`p.origem = $${params.length}`); }
  // Filtros extras usados só pelo drill-down do card "Resumo" (Painel Hoje,
  // pedido do Bruno 2026-10-03) — etapaId pro "pedidos por etapa", apenasHoje
  // pro "valor total/novos pedidos do dia", proximosEntregaDias pro "pedidos
  // próximos da entrega".
  if (etapaId) { params.push(etapaId); condicoes.push(`p.etapa_id = $${params.length}`); }
  if (apenasHoje) condicoes.push(`p.criado_em::date = current_date`);
  if (proximosEntregaDias) {
    params.push(proximosEntregaDias);
    condicoes.push(`p.data_entrega between current_date and current_date + ($${params.length} || ' days')::interval`);
  }
  return { where: condicoes.join(' and '), params };
}

// Listagem individual (não agrupada) de pedidos — drill-down do card
// "Resumo": nome do cliente, WhatsApp, data do pedido, valor, data de
// entrega, tipo de frete e valor de frete (exatamente as colunas pedidas).
async function listarPedidosDetalhado(pool, tenantId, filtros) {
  const { where, params } = montarFiltro(tenantId, filtros);
  const { rows } = await pool.query(
    `select c.nome as cliente_nome, c.telefone as cliente_telefone, p.criado_em,
            p.valor_total, p.data_entrega, p.tipo_entrega, p.frete
     from crm_pedidos p
     join crm_clientes c on c.id = p.cliente_id
     join crm_etapas e on e.id = p.etapa_id
     where ${where}
     order by p.criado_em desc`,
    params
  );
  return rows;
}

async function relatorioPedidos(pool, tenantId, filtros) {
  const { where, params } = montarFiltro(tenantId, filtros);
  const juncao = `from crm_pedidos p join crm_clientes c on c.id = p.cliente_id join crm_etapas e on e.id = p.etapa_id where ${where}`;

  const { rows: resumoRows } = await pool.query(
    `select count(*)::int as quantidade, coalesce(sum(p.valor_total), 0) as valor_total,
            coalesce(sum(p.valor_recebido), 0) as valor_recebido, coalesce(sum(p.frete), 0) as frete_total
     ${juncao}`,
    params
  );
  const resumo = resumoRows[0];
  resumo.ticket_medio = resumo.quantidade > 0 ? Number(resumo.valor_total) / resumo.quantidade : 0;

  let detalhado = [];
  const grupo = AGRUPAMENTOS[filtros && filtros.agruparPor];
  if (grupo) {
    const { rows } = await pool.query(
      `select ${grupo.chave} as chave, ${grupo.rotulo || grupo.chave} as rotulo,
              count(*)::int as quantidade, coalesce(sum(p.valor_total), 0) as valor_total
       ${juncao}
       group by ${grupo.chave}${grupo.rotulo ? `, ${grupo.rotulo}` : ''}
       order by valor_total desc`,
      params
    );
    detalhado = rows;
  }
  return { resumo, detalhado, agrupar_por: (filtros && filtros.agruparPor) || null };
}

module.exports = { relatorioPedidos, AGRUPAMENTOS, listarPedidosDetalhado };
