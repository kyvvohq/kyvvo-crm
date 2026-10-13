// Atendimento: o que a equipe faz com as conversas do agente — ver, aprovar/editar/
// descartar a sugestão (modo rascunho), assumir, responder, devolver ao agente.
// Toda função recebe o tenant do servidor (nunca do cliente) e filtra por ele.
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
  limite_turnos: 'Limite de turnos do agente',
  limite_custo: 'Limite de uso do agente',
  rate_limit: 'Excesso de mensagens da cliente',
  janela_expirada: 'Janela de 24 h expirada',
  falha_agente: 'Falha do agente',
  outro: 'Outro motivo',
};

class ErroAtendimento extends Error {
  constructor(status, mensagem) { super(mensagem); this.status = status; }
}

const SITUACOES = ['bot', 'aguardando_equipe', 'humano', 'encerrada'];
const TEXTO_MAX = 4000;

async function conversaDoTenant(pool, tenantId, id) {
  const { rows } = await pool.query('select * from crm_conversas_whatsapp where tenant_id = $1 and id = $2', [tenantId, id]);
  if (!rows[0]) throw new ErroAtendimento(404, 'Conversa não encontrada');
  return rows[0];
}

function limparTexto(t) {
  const texto = String(t || '').trim();
  if (!texto) throw new ErroAtendimento(400, 'Escreva a mensagem antes de enviar');
  if (texto.length > TEXTO_MAX) throw new ErroAtendimento(400, `Mensagem longa demais (máximo ${TEXTO_MAX} caracteres)`);
  return texto;
}

// Só conversas que o agente (ou a equipe pelo CRM) já tocou: o bot por lista antigo não aparece aqui.
const SO_AGENTE = `exists (select 1 from crm_mensagens_whatsapp m where m.tenant_id = c.tenant_id and m.telefone_e164 = c.telefone_e164 and m.autor is not null)`;

async function listarConversas(pool, tenantId, { situacao = 'todas' } = {}) {
  const filtro = SITUACOES.includes(situacao) ? 'and c.situacao = $2' : 'and $2::text is not null';
  const { rows } = await pool.query(
    `select c.id, c.telefone_e164, c.situacao, c.janela_expira_em, c.ultima_msg_cliente_em,
            coalesce(nullif(cl.nome, 'Sem nome'), c.nome_whatsapp) as cliente_nome,
            lm.conteudo as ultima_mensagem, lm.direcao as ultima_direcao, lm.autor as ultimo_autor, lm.criado_em as ultima_em,
            h.id as handoff_id, h.motivo as handoff_motivo, h.resumo as handoff_resumo, h.eh_vip, h.status as handoff_status, h.criado_em as handoff_em,
            (s.id is not null) as sugestao_pendente
       from crm_conversas_whatsapp c
       left join crm_clientes cl on cl.tenant_id = c.tenant_id and cl.id = c.cliente_id
       left join lateral (select conteudo, direcao, autor, criado_em from crm_mensagens_whatsapp m
                           where m.tenant_id = c.tenant_id and m.telefone_e164 = c.telefone_e164 order by criado_em desc, id desc limit 1) lm on true
       left join lateral (select id, motivo, resumo, eh_vip, status, criado_em from crm_handoffs h
                           where h.tenant_id = c.tenant_id and h.conversa_id = c.id and h.status in ('aberto', 'assumido') order by (h.status = 'aberto') desc, criado_em desc limit 1) h on true
       left join lateral (select id from crm_agente_execucoes e
                           where e.tenant_id = c.tenant_id and e.conversa_id = c.id and e.decisao is null and e.resposta_enviada is null and e.resposta_proposta is not null
                             and not exists (select 1 from crm_agente_execucoes e2 where e2.tenant_id = e.tenant_id and e2.conversa_id = e.conversa_id and e2.criado_em > e.criado_em)
                           limit 1) s on true
      where c.tenant_id = $1 ${filtro} and ${SO_AGENTE}
      order by (h.status = 'aberto') desc nulls last, h.eh_vip desc nulls last, coalesce(lm.criado_em, c.atualizado_em) desc
      limit 200`,
    [tenantId, SITUACOES.includes(situacao) ? situacao : 'todas'],
  );
  return rows.map((r) => ({ ...r, handoff_rotulo: r.handoff_motivo ? MOTIVOS_ROTULO[r.handoff_motivo] || r.handoff_motivo : null }));
}

async function obterConversa(pool, tenantId, id) {
  const c = await conversaDoTenant(pool, tenantId, id);
  const { rows: [cliente] } = c.cliente_id
    ? await pool.query('select id, nome, telefone from crm_clientes where tenant_id = $1 and id = $2', [tenantId, c.cliente_id])
    : { rows: [] };
  const { rows: mensagens } = await pool.query(
    `select m.id, m.direcao, m.autor, m.tipo, m.conteudo, m.criado_em, m.status_entrega,
            a.id as anexo_id, a.nome_arquivo as anexo_nome, a.mime as anexo_mime, a.tamanho as anexo_tamanho
       from crm_mensagens_whatsapp m left join crm_anexos a on a.id = m.anexo_id and a.tenant_id = m.tenant_id
      where m.tenant_id = $1 and m.telefone_e164 = $2 order by m.criado_em, m.id`, [tenantId, c.telefone_e164]);
  const { rows: [sug] } = await pool.query(
    `select id, resposta_proposta, resposta_original, bloqueada_por_filtro, motivo_bloqueio, ferramentas_chamadas, criado_em
       from crm_agente_execucoes e
      where e.tenant_id = $1 and e.conversa_id = $2 and e.decisao is null and e.resposta_enviada is null and e.resposta_proposta is not null
        and not exists (select 1 from crm_agente_execucoes e2 where e2.tenant_id = e.tenant_id and e2.conversa_id = e.conversa_id and e2.criado_em > e.criado_em)
      limit 1`, [tenantId, id]);
  const { rows: [handoff] } = await pool.query(
    `select id, motivo, resumo, dados_coletados, eh_vip, status, criado_em from crm_handoffs
      where tenant_id = $1 and conversa_id = $2 and status in ('aberto', 'assumido') order by (status = 'aberto') desc, criado_em desc limit 1`, [tenantId, id]);
  let pedido = null;
  if (c.cliente_id) {
    const { rows: [p] } = await pool.query(
      `select p.id, p.numero, p.rascunho, p.origem, p.identificador_externo, p.aguardando_conferencia, p.observacoes
         from crm_pedidos p where p.tenant_id = $1 and p.cliente_id = $2 and p.rascunho order by p.criado_em desc limit 1`, [tenantId, c.cliente_id]);
    if (p) {
      const { rows: campos } = await pool.query(
        `select cc.label, cc.chave, v.valor from crm_pedidos_valores v join crm_campos_customizados cc on cc.id = v.campo_id
          where v.pedido_id = $1 and cc.tenant_id = $2 order by cc.ordem`, [p.id, tenantId]);
      const { rows: [it] } = await pool.query('select descricao, quantidade from crm_pedidos_itens where pedido_id = $1 limit 1', [p.id]);
      pedido = { ...p, campos, item: it ? { descricao: it.descricao, quantidade: Number(it.quantidade) } : null };
    }
  }
  return {
    conversa: {
      id: c.id, telefone: c.telefone_e164, situacao: c.situacao, janela_expira_em: c.janela_expira_em,
      janela_aberta: !!c.janela_expira_em && new Date(c.janela_expira_em) > new Date(), cliente_id: c.cliente_id,
      cliente_nome: (cliente && cliente.nome !== 'Sem nome' ? cliente.nome : null) || c.nome_whatsapp,
    },
    mensagens,
    sugestao: sug ? {
      execucao_id: sug.id, texto: sug.resposta_proposta, bloqueada: sug.bloqueada_por_filtro, motivo_bloqueio: sug.motivo_bloqueio,
      original: sug.resposta_original, criada_em: sug.criado_em,
    } : null,
    handoff: handoff ? { ...handoff, rotulo: MOTIVOS_ROTULO[handoff.motivo] || handoff.motivo } : null,
    pedido,
  };
}

async function numeroDoCanal(pool, tenantId) {
  const { rows } = await pool.query("select phone_number_id from crm_whatsapp_numeros where tenant_id = $1 and status = 'ativo' order by criado_em limit 1", [tenantId]);
  if (!rows[0]) throw new ErroAtendimento(409, 'Nenhum número de WhatsApp conectado a esta conta');
  return rows[0].phone_number_id;
}

// Envia texto livre pela Cloud API (só dentro da janela de 24 h) e registra a mensagem.
async function enviarPeloCanal(pool, tenantId, conversa, texto, autor, deps) {
  if (!conversa.janela_expira_em || new Date(conversa.janela_expira_em) <= (deps.agora ? deps.agora() : new Date())) {
    throw new ErroAtendimento(409, 'A janela de 24 h desta conversa expirou: só dá para responder quando a cliente escrever de novo');
  }
  const phoneNumberId = await numeroDoCanal(pool, tenantId);
  const ok = await deps.enviarTexto({ to: conversa.telefone_e164, texto, phoneNumberId });
  if (!ok) throw new ErroAtendimento(502, 'Não foi possível enviar pelo WhatsApp agora. Tente novamente');
  const { rows: [m] } = await pool.query(
    `insert into crm_mensagens_whatsapp (tenant_id, telefone_e164, direcao, tipo, conteudo, autor, processada_em)
     values ($1, $2, 'enviada', 'texto', $3, $4, now()) returning id`, [tenantId, conversa.telefone_e164, texto, autor]);
  return m.id;
}

async function evento(pool, tenantId, conversa, tipo, userId, dados) {
  await pool.query('insert into crm_eventos (tenant_id, cliente_id, tipo, dados, ator_id) values ($1, $2, $3, $4, $5)',
    [tenantId, conversa.cliente_id, tipo, JSON.stringify(dados || {}), userId || null]);
}

async function descartarSugestoesPendentes(pool, tenantId, conversaId) {
  await pool.query(
    `update crm_agente_execucoes set decisao = 'descartada', decidida_em = now()
      where tenant_id = $1 and conversa_id = $2 and decisao is null and resposta_enviada is null and resposta_proposta is not null`, [tenantId, conversaId]);
}

// Aprovar (sem edição) ou editar e enviar a sugestão do agente.
async function enviarSugestao(pool, tenantId, userId, execucaoId, texto, deps) {
  const { rows: [e] } = await pool.query('select * from crm_agente_execucoes where tenant_id = $1 and id = $2', [tenantId, execucaoId]);
  if (!e) throw new ErroAtendimento(404, 'Sugestão não encontrada');
  if (e.decisao || e.resposta_enviada) throw new ErroAtendimento(409, 'Esta sugestão já foi tratada');
  const conversa = await conversaDoTenant(pool, tenantId, e.conversa_id);
  const final = limparTexto(texto === undefined || texto === null ? e.resposta_proposta : texto);
  const editada = final !== String(e.resposta_proposta || '').trim();
  await enviarPeloCanal(pool, tenantId, conversa, final, editada ? 'humano' : 'agente', deps);
  await pool.query(
    "update crm_agente_execucoes set decisao = $3, resposta_enviada = $4, decidida_em = now() where tenant_id = $1 and id = $2",
    [tenantId, execucaoId, editada ? 'editada' : 'aprovada', final]);
  await evento(pool, tenantId, conversa, 'atendimento_sugestao', userId, { execucao: execucaoId, decisao: editada ? 'editada' : 'aprovada' });
  return { ok: true, decisao: editada ? 'editada' : 'aprovada' };
}

async function descartarSugestao(pool, tenantId, userId, execucaoId) {
  const { rows: [e] } = await pool.query('select * from crm_agente_execucoes where tenant_id = $1 and id = $2', [tenantId, execucaoId]);
  if (!e) throw new ErroAtendimento(404, 'Sugestão não encontrada');
  if (e.decisao || e.resposta_enviada) throw new ErroAtendimento(409, 'Esta sugestão já foi tratada');
  await pool.query("update crm_agente_execucoes set decisao = 'descartada', decidida_em = now() where tenant_id = $1 and id = $2", [tenantId, execucaoId]);
  const conversa = await conversaDoTenant(pool, tenantId, e.conversa_id);
  await evento(pool, tenantId, conversa, 'atendimento_sugestao', userId, { execucao: execucaoId, decisao: 'descartada' });
  return { ok: true };
}

// A equipe assume: o agente fica em silêncio nesta conversa até ser devolvida.
async function assumir(pool, tenantId, userId, conversaId) {
  const conversa = await conversaDoTenant(pool, tenantId, conversaId);
  await pool.query("update crm_conversas_whatsapp set situacao = 'humano', pausada_ate = null, atualizado_em = now() where tenant_id = $1 and id = $2", [tenantId, conversaId]);
  await pool.query(
    "update crm_handoffs set status = 'assumido', atribuido_a = $3, atualizado_em = now() where tenant_id = $1 and conversa_id = $2 and status = 'aberto'", [tenantId, conversaId, userId || null]);
  await descartarSugestoesPendentes(pool, tenantId, conversaId);
  await evento(pool, tenantId, conversa, 'atendimento_assumido', userId, {});
  return { ok: true, situacao: 'humano' };
}

// Resposta escrita pela equipe no CRM: também assume a conversa (o agente pausa).
async function responderComoHumano(pool, tenantId, userId, conversaId, texto, deps) {
  const conversa = await conversaDoTenant(pool, tenantId, conversaId);
  const final = limparTexto(texto);
  await enviarPeloCanal(pool, tenantId, conversa, final, 'humano', deps);
  await assumir(pool, tenantId, userId, conversaId);
  return { ok: true };
}

async function devolverAoAgente(pool, tenantId, userId, conversaId) {
  const conversa = await conversaDoTenant(pool, tenantId, conversaId);
  await pool.query("update crm_conversas_whatsapp set situacao = 'bot', pausada_ate = null, atualizado_em = now() where tenant_id = $1 and id = $2", [tenantId, conversaId]);
  await pool.query("update crm_handoffs set status = 'resolvido', atualizado_em = now() where tenant_id = $1 and conversa_id = $2 and status in ('aberto', 'assumido')", [tenantId, conversaId]);
  await evento(pool, tenantId, conversa, 'atendimento_devolvido_ao_agente', userId, {});
  return { ok: true, situacao: 'bot' };
}

async function encerrar(pool, tenantId, userId, conversaId) {
  const conversa = await conversaDoTenant(pool, tenantId, conversaId);
  await pool.query("update crm_conversas_whatsapp set situacao = 'encerrada', atualizado_em = now() where tenant_id = $1 and id = $2", [tenantId, conversaId]);
  await pool.query("update crm_handoffs set status = 'resolvido', atualizado_em = now() where tenant_id = $1 and conversa_id = $2 and status in ('aberto', 'assumido')", [tenantId, conversaId]);
  await descartarSugestoesPendentes(pool, tenantId, conversaId);
  await evento(pool, tenantId, conversa, 'atendimento_encerrado', userId, {});
  return { ok: true, situacao: 'encerrada' };
}

// Encaminhamentos abertos para o Painel Hoje: VIP primeiro, depois o que espera há mais tempo.
async function listarEncaminhamentos(pool, tenantId, limite = 30) {
  const { rows } = await pool.query(
    `select h.id, h.conversa_id, h.motivo, h.resumo, h.eh_vip, h.criado_em,
            coalesce(nullif(cl.nome, 'Sem nome'), c.nome_whatsapp, c.telefone_e164) as cliente_nome, c.telefone_e164 as telefone,
            floor(extract(epoch from (now() - h.criado_em)) / 60)::int as minutos_esperando
       from crm_handoffs h join crm_conversas_whatsapp c on c.tenant_id = h.tenant_id and c.id = h.conversa_id
       left join crm_clientes cl on cl.tenant_id = h.tenant_id and cl.id = h.cliente_id
      where h.tenant_id = $1 and h.status = 'aberto'
      order by h.eh_vip desc, h.criado_em asc limit $2`, [tenantId, limite]);
  return rows.map((r) => ({ ...r, rotulo: MOTIVOS_ROTULO[r.motivo] || r.motivo }));
}

async function contarAbertos(pool, tenantId) {
  const { rows: [r] } = await pool.query("select count(*)::int as n from crm_handoffs where tenant_id = $1 and status = 'aberto'", [tenantId]);
  return r.n;
}

async function obterConfig(pool, tenantId) {
  const { rows: [c] } = await pool.query('select modo, modelo_runtime, horario_atendimento from crm_agente_config where tenant_id = $1', [tenantId]);
  return c ? { configurado: true, ...c } : { configurado: false, modo: 'desligado' };
}

// Chave de liga/desliga: só o modo. O resto da configuração vem do seed por conta.
async function definirModo(pool, tenantId, userId, modo) {
  if (!['desligado', 'rascunho', 'automatico'].includes(modo)) throw new ErroAtendimento(400, 'Modo inválido');
  const { rowCount } = await pool.query('update crm_agente_config set modo = $2, atualizado_em = now() where tenant_id = $1', [tenantId, modo]);
  if (!rowCount) throw new ErroAtendimento(409, 'O agente ainda não foi configurado para esta conta');
  await pool.query('insert into crm_eventos (tenant_id, tipo, dados, ator_id) values ($1, $2, $3, $4)', [tenantId, 'agente_modo', JSON.stringify({ modo }), userId || null]);
  return { ok: true, modo };
}

// A equipe revisou o rascunho criado pelo agente: vira pedido normal.
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
