// Ferramentas do agente — todas server-side. O tenant e a conversa vêm do
// servidor (ctx.tenantId / ctx.conversaId), NUNCA do modelo: nenhuma
// ferramenta aceita tenant_id ou id de cliente/pedido como parâmetro. Toda
// query filtra por tenant_id. Não existem ferramentas de preço, frete, prazo,
// pagamento ou estoque (ponto de extensão: novas ferramentas entram aqui
// quando houver base de produtos/preços). Nenhuma altera pagamento, etapa
// (além da inicial) ou apaga dados.
const { encontrarOuCriarPorTelefone } = require('../clientes');
const { proximoNumeroPedido } = require('../pedidos');

const MOTIVOS = [
  'reclamacao', 'produto_danificado_ou_diferente', 'pedido_humano', 'urgencia', 'negociacao_desconto',
  'modelo_complexo', 'pedido_atrasado', 'andamento_pedido', 'pergunta_valor_prazo_frete_pagamento',
  'nao_entendeu', 'vip_nao_confirmado', 'midia_nao_suportada', 'arquivo_recebido', 'bloqueio_filtro',
  'limite_turnos', 'limite_custo', 'janela_expirada', 'falha_agente', 'outro',
];

const FERRAMENTAS = [
  {
    name: 'buscar_ou_criar_cliente',
    description: 'Identifica a cliente desta conversa pelo telefone (cria o cadastro se ainda não existir). Chame no início da conversa. Nunca peça CPF.',
    input_schema: { type: 'object', properties: { nome: { type: 'string', description: 'Nome da cliente, se ela informou' } }, additionalProperties: false },
  },
  {
    name: 'registrar_briefing',
    description: 'Cria ou atualiza o pedido rascunho desta cliente com o briefing coletado. Envie só os campos que são novidade. Não altera pagamento nem etapa.',
    input_schema: {
      type: 'object',
      properties: {
        produto_modelo: { type: 'string', description: 'Produto ou modelo desejado' },
        categoria: { type: 'string', description: 'Categoria (ex.: Cortador, Ejetor, Carimbo de doces, Personalizado)' },
        quantidade: { type: 'integer', minimum: 1, description: 'Quantidade informada pela cliente' },
        personalizacao: { type: 'string', description: 'Logo, nomes, textos' },
        cores: { type: 'string' },
        medida: { type: 'string' },
        formato: { type: 'string' },
        uso: { type: 'string', description: 'Onde ou para que será usado' },
        data_desejada: { type: 'string', description: 'Data desejada no formato AAAA-MM-DD' },
        cep_cidade: { type: 'string', description: 'CEP ou cidade (apenas como dado)' },
        observacoes: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'registrar_id_shopee',
    description: 'Registra o ID do pedido da Shopee informado pela cliente. A equipe confere depois.',
    input_schema: { type: 'object', properties: { id_pedido: { type: 'string' } }, required: ['id_pedido'], additionalProperties: false },
  },
  {
    name: 'consultar_cliente_vip',
    description: 'Verifica no CRM se a cliente tem a TAG VIP. Só afirme desconto se vip for true, usando a frase retornada.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'consultar_status_pedido',
    description: 'Consulta (somente leitura) o andamento do último pedido da cliente. O resultado vai para o resumo da equipe; não repasse andamento à cliente a menos que o resultado traga o campo status.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'transferir_para_equipe',
    description: 'Encaminha a conversa para a equipe, com motivo e um resumo curto do que foi coletado e do que a cliente quer.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string', enum: MOTIVOS },
        resumo: { type: 'string', description: 'Resumo objetivo para a equipe, até 600 caracteres' },
      },
      required: ['motivo', 'resumo'],
      additionalProperties: false,
    },
  },
  {
    name: 'registrar_autorizacao_imagem',
    description: 'Registra se a cliente autorizou ou não a equipe a postar a foto do produto dela no grupo VIP.',
    input_schema: { type: 'object', properties: { autoriza: { type: 'boolean' } }, required: ['autoriza'], additionalProperties: false },
  },
];

function texto(v, max = 500) {
  if (v === undefined || v === null) return undefined;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : undefined;
}

async function carregarConversa(pool, tenantId, conversaId) {
  const { rows } = await pool.query('select * from crm_conversas_whatsapp where tenant_id = $1 and id = $2', [tenantId, conversaId]);
  if (!rows[0]) throw new Error('conversa não encontrada para este tenant');
  return rows[0];
}

async function evento(pool, ctx, { clienteId = null, pedidoId = null, tipo, dados }) {
  await pool.query(
    'insert into crm_eventos (tenant_id, cliente_id, pedido_id, tipo, dados) values ($1, $2, $3, $4, $5)',
    [ctx.tenantId, clienteId, pedidoId, tipo, JSON.stringify({ ator: 'agente', ...dados })],
  );
}

async function garantirCliente(pool, ctx, nome) {
  const conversa = await carregarConversa(pool, ctx.tenantId, ctx.conversaId);
  const cliente = await encontrarOuCriarPorTelefone(pool, ctx.tenantId, {
    telefone: conversa.telefone_e164, nome: nome || conversa.nome_whatsapp, origem: 'WhatsApp',
  });
  if (conversa.cliente_id !== cliente.id) {
    await pool.query('update crm_conversas_whatsapp set cliente_id = $3, atualizado_em = now() where tenant_id = $1 and id = $2', [ctx.tenantId, ctx.conversaId, cliente.id]);
  }
  ctx.estado.clienteId = cliente.id;
  return cliente;
}

// Pedido rascunho aberto da cliente (um por vez); cria na etapa inicial fixa.
async function garantirPedidoRascunho(pool, ctx) {
  const cliente = await garantirCliente(pool, ctx);
  const { rows } = await pool.query(
    `select p.* from crm_pedidos p join crm_etapas e on e.id = p.etapa_id
      where p.tenant_id = $1 and p.cliente_id = $2 and p.rascunho and e.tipo = 'aberta'
      order by p.criado_em desc limit 1`,
    [ctx.tenantId, cliente.id]);
  if (rows[0]) { ctx.estado.pedidoId = rows[0].id; return rows[0]; }

  const { rows: [etapa] } = await pool.query('select id from crm_etapas where tenant_id = $1 and fixa = true limit 1', [ctx.tenantId]);
  if (!etapa) throw new Error('conta sem etapa inicial (fixa) configurada');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const numero = await proximoNumeroPedido(client, ctx.tenantId);
    const { rows: [pedido] } = await client.query(
      `insert into crm_pedidos (tenant_id, cliente_id, etapa_id, origem, numero, rascunho)
       values ($1, $2, $3, 'WhatsApp', $4, true) returning *`,
      [ctx.tenantId, cliente.id, etapa.id, numero]);
    await client.query(
      `insert into crm_eventos (tenant_id, cliente_id, pedido_id, tipo, dados) values ($1, $2, $3, 'criacao', $4)`,
      [ctx.tenantId, cliente.id, pedido.id, JSON.stringify({ ator: 'agente', origem: 'agente_whatsapp', rascunho: true })]);
    await client.query('COMMIT');
    ctx.estado.pedidoId = pedido.id;
    return pedido;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

function categoriaPadrao(config, categoria) {
  if (!categoria) return null;
  const alvo = String(categoria).toLowerCase();
  const achada = ((config.regras_categoria || {}).categorias || []).find((c) => alvo.includes(String(c.nome).toLowerCase()));
  return achada ? achada.quantidade_padrao : null;
}

async function registrarBriefing(pool, ctx, input) {
  const pedido = await garantirPedidoRascunho(pool, ctx);
  const campos = {};
  for (const k of ['produto_modelo', 'categoria', 'personalizacao', 'cores', 'medida', 'formato', 'uso', 'cep_cidade']) {
    const v = texto(input[k]);
    if (v) campos[k] = v;
  }
  if (input.data_desejada !== undefined) {
    const d = texto(input.data_desejada, 10);
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) throw new Error('data_desejada deve estar no formato AAAA-MM-DD');
    campos.data_desejada = d;
  }
  let quantidade = null;
  if (input.quantidade !== undefined) {
    quantidade = Number(input.quantidade);
    if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > 100000) throw new Error('quantidade inválida');
  }

  const { rows: defs } = await pool.query(
    "select id, chave from crm_campos_customizados where tenant_id = $1 and entidade = 'pedido' and chave = any($2)",
    [ctx.tenantId, Object.keys(campos)]);
  for (const def of defs) {
    await pool.query(
      `insert into crm_pedidos_valores (pedido_id, campo_id, valor) values ($1, $2, $3)
       on conflict (pedido_id, campo_id) do update set valor = excluded.valor`,
      [pedido.id, def.id, campos[def.chave]]);
  }

  // Item do pedido: só existe quando a quantidade é conhecida (informada ou padrão da categoria).
  let quantidadeAssumida = null;
  const { rows: itens } = await pool.query('select id, quantidade from crm_pedidos_itens where pedido_id = $1 order by id limit 1', [pedido.id]);
  const { rows: [valorCat] } = await pool.query(
    `select v.valor from crm_pedidos_valores v join crm_campos_customizados c on c.id = v.campo_id
      where v.pedido_id = $1 and c.chave = 'categoria' and c.tenant_id = $2`, [pedido.id, ctx.tenantId]);
  const categoria = campos.categoria || (valorCat && valorCat.valor);
  if (quantidade === null && !itens[0]) {
    const padrao = categoriaPadrao(ctx.config, categoria);
    if (padrao) { quantidade = padrao; quantidadeAssumida = padrao; }
  }
  if (quantidade !== null || campos.produto_modelo) {
    if (itens[0]) {
      await pool.query(
        'update crm_pedidos_itens set quantidade = coalesce($2, quantidade), descricao = coalesce($3, descricao) where id = $1',
        [itens[0].id, quantidade, campos.produto_modelo || null]);
    } else if (quantidade !== null) {
      await pool.query(
        'insert into crm_pedidos_itens (pedido_id, descricao, quantidade, valor_unitario) values ($1, $2, $3, 0)',
        [pedido.id, campos.produto_modelo || 'A definir pelo briefing', quantidade]);
    }
  }
  const obs = texto(input.observacoes, 1000);
  if (obs) {
    await pool.query(
      `update crm_pedidos set observacoes = case when coalesce(observacoes, '') = '' then $3 else observacoes || E'\n' || $3 end, atualizado_em = now()
        where tenant_id = $1 and id = $2`, [ctx.tenantId, pedido.id, obs]);
  }
  await evento(pool, ctx, { clienteId: pedido.cliente_id, pedidoId: pedido.id, tipo: 'agente_briefing', dados: { campos, quantidade, observacoes: obs } });

  const resultado = { ok: true, pedido: pedido.numero, campos_registrados: Object.keys(campos).concat(quantidade !== null ? ['quantidade'] : []) };
  if (quantidadeAssumida) resultado.quantidade_assumida = `${quantidadeAssumida} (padrão da categoria) — confirme com a cliente`;
  return resultado;
}

async function registrarIdShopee(pool, ctx, input) {
  const id = texto(input.id_pedido, 40);
  if (!id || !/^[A-Za-z0-9]{8,24}$/.test(id)) throw new Error('ID de pedido Shopee inválido (esperado 8 a 24 letras e números)');
  const pedido = await garantirPedidoRascunho(pool, ctx);
  const { rows: [outro] } = await pool.query(
    "select id, numero from crm_pedidos where tenant_id = $1 and origem = 'Shopee' and identificador_externo = $2 and id <> $3",
    [ctx.tenantId, id, pedido.id]);
  if (outro) {
    // A importação já trouxe esse pedido: não duplica, só avisa a equipe.
    await pool.query('update crm_pedidos set aguardando_conferencia = true, atualizado_em = now() where tenant_id = $1 and id = $2', [ctx.tenantId, pedido.id]);
    await evento(pool, ctx, { clienteId: pedido.cliente_id, pedidoId: pedido.id, tipo: 'agente_id_shopee', dados: { id_shopee: id, ja_existe_no_pedido: outro.numero } });
    return { ok: true, ja_existe: true, observacao: 'A equipe vai conferir.' };
  }
  await pool.query(
    "update crm_pedidos set origem = 'Shopee', identificador_externo = $3, aguardando_conferencia = true, atualizado_em = now() where tenant_id = $1 and id = $2",
    [ctx.tenantId, pedido.id, id]);
  await evento(pool, ctx, { clienteId: pedido.cliente_id, pedidoId: pedido.id, tipo: 'agente_id_shopee', dados: { id_shopee: id } });
  return { ok: true, observacao: 'Registrado como aguardando conferência da equipe.' };
}

async function consultarClienteVip(pool, ctx) {
  const cliente = await garantirCliente(pool, ctx);
  const tag = String((ctx.config.vip || {}).tag || 'VIP');
  const { rows } = await pool.query(
    `select 1 from crm_clientes_tags ct join crm_tags t on t.id = ct.tag_id
      where t.tenant_id = $1 and ct.cliente_id = $2 and lower(t.nome) = lower($3) limit 1`,
    [ctx.tenantId, cliente.id, tag]);
  const vip = rows.length > 0;
  ctx.estado.vipVerificado = vip;
  if (!vip) return { vip: false, instrucao: 'Diga que a equipe vai confirmar e use transferir_para_equipe.' };
  return { vip: true, frase: (ctx.config.textos || {}).desconto_vip, instrucao: 'Use exatamente esta frase, sem acrescentar números ou condições.' };
}

async function consultarStatusPedido(pool, ctx) {
  const cliente = await garantirCliente(pool, ctx);
  const { rows: [p] } = await pool.query(
    `select p.numero, e.nome as etapa from crm_pedidos p join crm_etapas e on e.id = p.etapa_id
      where p.tenant_id = $1 and p.cliente_id = $2 and not p.rascunho order by p.criado_em desc limit 1`,
    [ctx.tenantId, cliente.id]);
  ctx.estado.statusConsultado = p ? { pedido: p.numero, etapa: p.etapa } : { pedido: null };
  if ((ctx.config.flags || {}).status_automatico === true && p) return { status: p.etapa, pedido: p.numero };
  return { registrado_para_equipe: true, instrucao: 'Não informe andamento. Diga que vai verificar com a equipe e use transferir_para_equipe.' };
}

async function transferirParaEquipe(pool, ctx, input) {
  const motivo = MOTIVOS.includes(input.motivo) ? input.motivo : 'outro';
  const resumo = texto(input.resumo, 600) || 'Sem resumo.';
  const conversa = await carregarConversa(pool, ctx.tenantId, ctx.conversaId);
  const clienteId = conversa.cliente_id || ctx.estado.clienteId || null;
  let pedidoId = ctx.estado.pedidoId || null;
  if (!pedidoId && clienteId) {
    const { rows } = await pool.query('select id from crm_pedidos where tenant_id = $1 and cliente_id = $2 and rascunho order by criado_em desc limit 1', [ctx.tenantId, clienteId]);
    pedidoId = rows[0] ? rows[0].id : null;
  }
  const dados = {};
  if (pedidoId) {
    const { rows } = await pool.query(
      `select c.chave, v.valor from crm_pedidos_valores v join crm_campos_customizados c on c.id = v.campo_id
        where v.pedido_id = $1 and c.tenant_id = $2`, [pedidoId, ctx.tenantId]);
    for (const r of rows) dados[r.chave] = r.valor;
    const { rows: [it] } = await pool.query('select quantidade from crm_pedidos_itens where pedido_id = $1 order by id limit 1', [pedidoId]);
    if (it) dados.quantidade = Number(it.quantidade);
  }
  if (ctx.estado.statusConsultado) dados.status_consultado = ctx.estado.statusConsultado;

  let ehVip = ctx.estado.vipVerificado;
  if (ehVip === undefined && clienteId) {
    const tag = String((ctx.config.vip || {}).tag || 'VIP');
    const { rows } = await pool.query(
      `select 1 from crm_clientes_tags ct join crm_tags t on t.id = ct.tag_id
        where t.tenant_id = $1 and ct.cliente_id = $2 and lower(t.nome) = lower($3) limit 1`, [ctx.tenantId, clienteId, tag]);
    ehVip = rows.length > 0;
  }

  await pool.query(
    `insert into crm_handoffs (tenant_id, conversa_id, cliente_id, pedido_id, motivo, resumo, dados_coletados, eh_vip)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (tenant_id, conversa_id) where status = 'aberto' do update set
       motivo = excluded.motivo, resumo = excluded.resumo, dados_coletados = excluded.dados_coletados,
       pedido_id = coalesce(excluded.pedido_id, crm_handoffs.pedido_id), eh_vip = excluded.eh_vip, atualizado_em = now()`,
    [ctx.tenantId, ctx.conversaId, clienteId, pedidoId, motivo, resumo, JSON.stringify(dados), !!ehVip]);
  await pool.query("update crm_conversas_whatsapp set situacao = 'aguardando_equipe', atualizado_em = now() where tenant_id = $1 and id = $2 and situacao in ('bot', 'encerrada')", [ctx.tenantId, ctx.conversaId]);
  await evento(pool, ctx, { clienteId, pedidoId, tipo: 'agente_handoff', dados: { motivo, resumo } });
  ctx.estado.transferiu = true;
  return { ok: true, observacao: 'Conversa encaminhada. Avise a cliente em uma mensagem curta.' };
}

async function registrarAutorizacaoImagem(pool, ctx, input) {
  if (typeof input.autoriza !== 'boolean') throw new Error('autoriza deve ser true ou false');
  const cliente = await garantirCliente(pool, ctx);
  await evento(pool, ctx, { clienteId: cliente.id, tipo: 'autorizacao_imagem', dados: { autoriza: input.autoriza, registrado_em: new Date().toISOString() } });
  return { ok: true };
}

// Chamada pelo código (não pelo modelo): anexa ao pedido rascunho os arquivos
// recebidos nas mensagens, sem avaliar viabilidade. Idempotente.
async function anexarMidia(pool, ctx, mensagens) {
  const comAnexo = mensagens.filter((m) => m.anexo_id);
  if (comAnexo.length === 0) return 0;
  const pedido = await garantirPedidoRascunho(pool, ctx);
  let n = 0;
  for (const m of comAnexo) {
    const { rows: [a] } = await pool.query('select * from crm_anexos where tenant_id = $1 and id = $2', [ctx.tenantId, m.anexo_id]);
    if (!a || a.pedido_id === pedido.id) continue;
    await pool.query('update crm_anexos set pedido_id = $3 where tenant_id = $1 and id = $2', [ctx.tenantId, a.id, pedido.id]);
    // aparece também na lista de arquivos do pedido que o CRM já tem
    await pool.query(
      `insert into crm_pedidos_arquivos (pedido_id, nome_arquivo, caminho_arquivo, tipo_mime, media_id_whatsapp)
       values ($1, $2, $3, $4, $5)`,
      [pedido.id, a.nome_arquivo, `agente/${a.chave_armazenamento}`, a.mime, (m.midia || {}).mediaId || null]);
    n += 1;
  }
  if (n > 0) await evento(pool, ctx, { clienteId: pedido.cliente_id, pedidoId: pedido.id, tipo: 'agente_anexos', dados: { quantidade: n } });
  return n;
}

const TABELA = {
  buscar_ou_criar_cliente: async (pool, ctx, input) => {
    const c = await garantirCliente(pool, ctx, texto(input.nome, 120));
    return { ok: true, nome: c.nome === 'Sem nome' ? null : c.nome, cliente_novo: !!(c.criado_em && Date.now() - new Date(c.criado_em).getTime() < 60000) };
  },
  registrar_briefing: registrarBriefing,
  registrar_id_shopee: registrarIdShopee,
  consultar_cliente_vip: consultarClienteVip,
  consultar_status_pedido: consultarStatusPedido,
  transferir_para_equipe: transferirParaEquipe,
  registrar_autorizacao_imagem: registrarAutorizacaoImagem,
};

async function executarFerramenta(pool, ctx, nome, input) {
  const fn = TABELA[nome];
  if (!fn) throw new Error(`ferramenta desconhecida: ${nome}`);
  // garante conversa do tenant antes de qualquer coisa (falha se for de outra conta)
  await carregarConversa(pool, ctx.tenantId, ctx.conversaId);
  return fn(pool, ctx, input && typeof input === 'object' ? input : {});
}

module.exports = { FERRAMENTAS, MOTIVOS, executarFerramenta, anexarMidia, garantirCliente, garantirPedidoRascunho, transferirParaEquipe };
