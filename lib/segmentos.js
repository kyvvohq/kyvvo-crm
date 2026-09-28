// Resolve um segmento (filtros combináveis, seção 7.5 do doc) numa lista de
// clientes. Todo valor vindo do usuário entra como parâmetro (nunca
// concatenado na string SQL) — só a PRESENÇA de cada filtro decide se o
// pedaço de SQL entra ou não, os valores em si sempre são $N.
async function resolverSegmento(pool, tenantId, filtros) {
  const f = filtros || {};
  const condicoes = ['c.tenant_id = $1'];
  const params = [tenantId];

  if (f.tag_id) {
    params.push(f.tag_id);
    condicoes.push(`c.id in (select cliente_id from crm_clientes_tags where tag_id = $${params.length})`);
  }
  if (f.cidade) {
    params.push(`%${String(f.cidade).toLowerCase()}%`);
    condicoes.push(`lower(c.cidade) like $${params.length}`);
  }
  if (f.origem) {
    params.push(String(f.origem).toLowerCase());
    condicoes.push(`lower(c.origem) = $${params.length}`);
  }
  if (f.produto_id) {
    params.push(f.produto_id);
    condicoes.push(`c.id in (
      select p.cliente_id from crm_pedidos p join crm_pedidos_itens pi on pi.pedido_id = p.id
      where pi.produto_id = $${params.length}
    )`);
  }
  // Dias sem comprar = desde a última compra "ganha" (pedido concluído).
  // Usa entrou_na_etapa_em (quando o pedido chegou na etapa "ganha"), não
  // criado_em (quando o pedido foi aberto) — um pedido pode levar semanas
  // entre aberto e entregue, e é a data de entrega que importa pra saber
  // há quanto tempo o cliente comprou de verdade.
  // Cliente que nunca comprou não entra aqui de propósito — esse filtro é
  // pra reativar quem já foi cliente, não pra achar quem nunca comprou.
  if (f.dias_sem_comprar_min !== undefined && f.dias_sem_comprar_min !== null && f.dias_sem_comprar_min !== '') {
    params.push(Number(f.dias_sem_comprar_min));
    condicoes.push(`(
      select max(p2.entrou_na_etapa_em) from crm_pedidos p2 join crm_etapas e2 on e2.id = p2.etapa_id
      where p2.cliente_id = c.id and e2.tipo = 'ganha'
    ) < now() - ($${params.length} || ' days')::interval`);
  }
  if (f.aniversario_mes) {
    condicoes.push(`c.data_nascimento is not null and extract(month from c.data_nascimento) = extract(month from current_date)`);
  }
  if (f.status_pagamento) {
    params.push(f.status_pagamento);
    condicoes.push(`c.id in (select cliente_id from crm_pedidos where status_pagamento = $${params.length})`);
  }
  if (f.consentimento) {
    condicoes.push('c.consentimento_data is not null');
  }

  const { rows } = await pool.query(
    `select c.* from crm_clientes c where ${condicoes.join(' and ')} order by c.nome`,
    params
  );
  return rows;
}

module.exports = { resolverSegmento };
