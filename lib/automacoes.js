// Motor de automação por gatilho (issue #40) — versão enxuta do
// kyvvo-people/lib/automacoes.js: só canal WhatsApp, sem trava de plano
// (o CRM não tem catálogo de planos ainda) e só funciona pra tenant com
// número vinculado em crm_whatsapp_numeros (V1, hoje só a Basic — decisão
// confirmada com o Bruno em 2026-09-25, "vamos alterar isso em breve").
const { enviarTemplate, listarTemplates } = require('@kyvvohq/whatsapp');
const { dispararNotificacaoEvento } = require('./notificacoes');

const GATILHOS_VALIDOS = ['mudanca_etapa', 'pedido_criado', 'pedido_parado', 'aniversario_cliente'];

// "Quantidade restante de disparos" (pedido do Bruno) — a Meta não expõe uma
// contagem exata de mensagens restantes via API, só um "tier" (limite de
// CONVERSAS iniciadas pelo negócio por janela de 24h). Mapeamento público
// da documentação da Cloud API — se a Meta mudar os nomes dos tiers, isso
// precisa ser atualizado junto.
const TIER_LIMITES = { TIER_50: 50, TIER_250: 250, TIER_1K: 1000, TIER_10K: 10000, TIER_100K: 100000 };

async function buscarLimiteMensagens(phoneNumberId) {
  const token = process.env.META_WHATSAPP_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(`https://graph.facebook.com/v22.0/${phoneNumberId}?fields=messaging_limit_tier`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const corpo = await res.json();
    return TIER_LIMITES[corpo.messaging_limit_tier] || null;
  } catch {
    return null;
  }
}

// Ordem posicional de fallback quando o template aprovado não usa parâmetro
// nomeado (ver montarParametros) — mesma ideia de
// kyvvo-people/lib/automacoes.js:PARAMETROS_CORPO_TEMPLATE.
const PARAMETROS_POSICIONAIS = {
  mudanca_etapa: (d) => [d.cliente, d.etapa],
  pedido_criado: (d) => [d.cliente, d.pedido_valor],
  pedido_parado: (d) => [d.cliente, d.etapa, d.dias_parado],
  aniversario_cliente: (d) => [d.cliente],
};

async function buscarPhoneNumberId(pool, tenantId) {
  const { rows } = await pool.query('select phone_number_id from crm_whatsapp_numeros where tenant_id = $1 limit 1', [tenantId]);
  return rows[0] ? rows[0].phone_number_id : null;
}

// Achado ao vivo (2026-10-20, Bruno): automação configurada certo, número
// vinculado ativo, e o disparo registrava status 'erro' mesmo assim —
// enviarAutomacao chamava listarTemplates() sem wabaId, então caía na WABA
// default do env (META_WABA_ID) em vez da WABA do PRÓPRIO tenant. Pro
// tenant cuja WABA é diferente da do env, o template nunca é encontrado
// (templateInfo fica undefined) e os parâmetros caem pro fallback
// posicional — se o template aprovado usa parâmetro NOMEADO (comum, ver
// comentário grande em @kyvvohq/whatsapp sobre o erro #132000 da Meta),
// a Meta rejeita o envio. Mesma correção já aplicada pelas rotas de
// listagem (/crm/api/campanhas/canais e /automacoes/templates-whatsapp,
// commit 4cee77d) — faltava aqui, no caminho que de fato envia.
async function buscarWabaId(pool, tenantId) {
  const { rows } = await pool.query('select meta_waba_id from crm_whatsapp_numeros where tenant_id = $1 limit 1', [tenantId]);
  return rows[0] ? rows[0].meta_waba_id : null;
}

async function enviadoRecentemente(pool, telefoneE164) {
  const { rows } = await pool.query(
    `select 1 from crm_whatsapp_envios where telefone_e164 = $1 and enviado_em > now() - interval '24 hours' limit 1`,
    [telefoneE164]
  );
  return rows.length > 0;
}

async function registrarEnvio(pool, tenantId, telefoneE164) {
  await pool.query('insert into crm_whatsapp_envios (tenant_id, telefone_e164) values ($1, $2)', [tenantId, telefoneE164]);
}

async function registrarDisparo(pool, { tenantId, telefoneE164, templateNome, gatilho, status, mensagemTexto, pedidoId }) {
  await pool.query(
    `insert into crm_whatsapp_disparos (tenant_id, telefone_e164, template_nome, gatilho, status, mensagem_texto, pedido_id)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, telefoneE164, templateNome || null, gatilho || null, status, mensagemTexto || null, pedidoId || null]
  );
}

// Só reenvia "pedido parado" se o pedido tiver entrado de novo na mesma
// etapa depois do último disparo (saiu e voltou) — evita repetir o aviso a
// cada rodada do checador enquanto ele continuar parado na mesma estadia.
async function jaAvisouParadoNestaEstadia(pool, pedidoId, entrouNaEtapaEm) {
  const { rows } = await pool.query(
    `select 1 from crm_whatsapp_disparos where pedido_id = $1 and gatilho = 'pedido_parado' and criado_em >= $2 limit 1`,
    [pedidoId, entrouNaEtapaEm]
  );
  return rows.length > 0;
}

// Aniversário roda diariamente (ver checarAniversariantes) — sem isso
// mandaria de novo a cada execução do checador no mesmo dia.
async function jaNotificouAniversarioHoje(pool, tenantId, telefoneE164) {
  const { rows } = await pool.query(
    `select 1 from crm_whatsapp_disparos
     where tenant_id = $1 and telefone_e164 = $2 and gatilho = 'aniversario_cliente' and criado_em::date = current_date limit 1`,
    [tenantId, telefoneE164]
  );
  return rows.length > 0;
}

// Reconstrói o texto final do template (corpo aprovado + parâmetros) só pra
// guardar em crm_whatsapp_disparos.mensagem_texto — espelha
// kyvvo-people/lib/automacoes.js:renderizarCorpoTemplate.
function renderizarCorpoTemplate(corpo, parametrosCorpo) {
  if (!corpo) return null;
  if (!parametrosCorpo || !parametrosCorpo.length) return corpo;
  if (parametrosCorpo[0].nomeado) {
    return parametrosCorpo.reduce((texto, p) => texto.split(`{{${p.nome}}}`).join(String(p.valor)), corpo);
  }
  return parametrosCorpo.reduce((texto, p, i) => texto.split(`{{${i + 1}}}`).join(String(p.valor)), corpo);
}

function montarParametros(gatilho, dados, templateInfo) {
  if (templateInfo && templateInfo.parametros_nomeados) {
    return templateInfo.parametros_corpo.map((nomeParam) => ({
      nome: nomeParam, nomeado: true, valor: dados[nomeParam] != null ? String(dados[nomeParam]) : '',
    }));
  }
  const montarPosicional = PARAMETROS_POSICIONAIS[gatilho];
  const valores = montarPosicional ? montarPosicional(dados) : [];
  return valores.map((valor) => ({ valor: valor != null ? String(valor) : '', nomeado: false }));
}

// Ponto único de envio — best-effort, nunca lança (uma automação mal
// configurada não pode derrubar a rota que a chamou). `pedidoId` é opcional
// (só existe pra gatilhos ligados a pedido).
async function enviarAutomacao(pool, { tenantId, automacao, telefone, dados, pedidoId }) {
  if (!telefone || !automacao.whatsapp_template) return;
  try {
    const phoneNumberId = await buscarPhoneNumberId(pool, tenantId);
    if (!phoneNumberId) return; // V1: sem número vinculado, automação fica sem efeito

    if (await enviadoRecentemente(pool, telefone)) {
      await registrarDisparo(pool, { tenantId, telefoneE164: telefone, templateNome: automacao.whatsapp_template, gatilho: automacao.gatilho, status: 'bloqueado_24h', pedidoId });
      return;
    }

    const wabaId = await buscarWabaId(pool, tenantId);
    const templates = await listarTemplates({ wabaId });
    const templateInfo = templates.find((t) => t.nome === automacao.whatsapp_template);
    const parametrosCorpo = montarParametros(automacao.gatilho, dados, templateInfo);
    const mensagemTexto = renderizarCorpoTemplate(templateInfo && templateInfo.corpo, parametrosCorpo);

    const enviado = await enviarTemplate({ to: telefone, templateName: automacao.whatsapp_template, parametrosCorpo, phoneNumberId });
    if (enviado) {
      await registrarEnvio(pool, tenantId, telefone);
      await registrarDisparo(pool, { tenantId, telefoneE164: telefone, templateNome: automacao.whatsapp_template, gatilho: automacao.gatilho, status: 'enviado', mensagemTexto, pedidoId });
    } else {
      await registrarDisparo(pool, { tenantId, telefoneE164: telefone, templateNome: automacao.whatsapp_template, gatilho: automacao.gatilho, status: 'erro', mensagemTexto, pedidoId });
    }
  } catch (err) {
    console.error(`[automacoes] falha ao disparar automação ${automacao.id} (${automacao.gatilho}): ${err.message}`);
  }
}

// Chamado por PATCH /crm/api/pedidos/:id/etapa (e pelo cancelamento, que
// também move de etapa) — dispara toda automação ativa cuja etapa de
// destino é a que o pedido acabou de entrar.
async function dispararMudancaEtapa(pool, { tenantId, pedidoId, etapaId, etapaNome, cliente }) {
  const { rows } = await pool.query(
    `select * from crm_automacoes where tenant_id = $1 and gatilho = 'mudanca_etapa' and etapa_id = $2 and ativo = true`,
    [tenantId, etapaId]
  );
  const dados = { cliente: cliente.nome, etapa: etapaNome };
  for (const automacao of rows) {
    await enviarAutomacao(pool, { tenantId, automacao, telefone: cliente.telefone, dados, pedidoId });
  }
}

// Chamado por POST /crm/api/pedidos (criação manual, seção 7.2). Não é
// chamado pelo bot de WhatsApp (lib/bot-whatsapp.js) — lá o próprio fluxo de
// conversa já confirma o pedido pro cliente, mandar uma automação em cima
// seria uma segunda mensagem redundante pro mesmo número.
async function dispararPedidoCriado(pool, { tenantId, pedidoId, cliente, valorTotal }) {
  const { rows } = await pool.query(
    `select * from crm_automacoes where tenant_id = $1 and gatilho = 'pedido_criado' and ativo = true`,
    [tenantId]
  );
  const dados = { cliente: cliente.nome, pedido_valor: valorTotal != null ? Number(valorTotal).toFixed(2) : '' };
  for (const automacao of rows) {
    await enviarAutomacao(pool, { tenantId, automacao, telefone: cliente.telefone, dados, pedidoId });
  }
}

// Checador periódico (chamado por setInterval em index.js, não a cada
// request) — pedido parado usa o prazo_alerta_dias já configurado na
// própria etapa (mesmo campo do card "orçamentos parados" do Painel Hoje).
async function checarPedidosParados(pool) {
  const { rows: automacoes } = await pool.query(
    `select a.*, e.nome as etapa_nome, e.prazo_alerta_dias
     from crm_automacoes a join crm_etapas e on e.id = a.etapa_id
     where a.gatilho = 'pedido_parado' and a.ativo = true and e.prazo_alerta_dias is not null`
  );
  for (const automacao of automacoes) {
    const { rows: pedidos } = await pool.query(
      `select p.id, p.entrou_na_etapa_em, c.nome as cliente_nome, c.telefone as cliente_telefone
       from crm_pedidos p join crm_clientes c on c.id = p.cliente_id
       where p.tenant_id = $1 and p.etapa_id = $2
         and p.entrou_na_etapa_em < now() - ($3 || ' days')::interval`,
      [automacao.tenant_id, automacao.etapa_id, automacao.prazo_alerta_dias]
    );
    for (const pedido of pedidos) {
      if (await jaAvisouParadoNestaEstadia(pool, pedido.id, pedido.entrou_na_etapa_em)) continue;
      const dados = { cliente: pedido.cliente_nome, etapa: automacao.etapa_nome, dias_parado: automacao.prazo_alerta_dias };
      await enviarAutomacao(pool, { tenantId: automacao.tenant_id, automacao, telefone: pedido.cliente_telefone, dados, pedidoId: pedido.id });
    }
  }
}

async function checarAniversariantes(pool) {
  const { rows: automacoes } = await pool.query(
    `select * from crm_automacoes where gatilho = 'aniversario_cliente' and ativo = true`
  );
  for (const automacao of automacoes) {
    const { rows: clientes } = await pool.query(
      `select id, nome, telefone from crm_clientes
       where tenant_id = $1 and data_nascimento is not null and not bloqueado
         and extract(month from data_nascimento) = extract(month from current_date)
         and extract(day from data_nascimento) = extract(day from current_date)`,
      [automacao.tenant_id]
    );
    for (const cliente of clientes) {
      if (!cliente.telefone) continue;
      if (await jaNotificouAniversarioHoje(pool, automacao.tenant_id, cliente.telefone)) continue;
      await enviarAutomacao(pool, { tenantId: automacao.tenant_id, automacao, telefone: cliente.telefone, dados: { cliente: cliente.nome } });
    }
  }
}

// Checa 1x por hora (mesmo checador das automações) se o uso de disparos nas
// últimas 24h está perto do limite de CONVERSAS iniciadas da Meta pro
// número do tenant — ver buscarLimiteMensagens acima. Best-effort: sem
// META_WHATSAPP_TOKEN ou tier desconhecido (número muito novo, por exemplo),
// simplesmente não checa esse tenant, não quebra o restante do checador.
// 1 aviso por tenant por dia (crm_notificacoes_eventos já tem o registro
// pra isso, não precisa de tabela nova).
async function checarLimiteDisparos(pool) {
  const { rows: numeros } = await pool.query('select distinct tenant_id, phone_number_id from crm_whatsapp_numeros');
  for (const { tenant_id: tenantId, phone_number_id: phoneNumberId } of numeros) {
    // eslint-disable-next-line no-await-in-loop
    const limite = await buscarLimiteMensagens(phoneNumberId);
    if (!limite) continue;

    // eslint-disable-next-line no-await-in-loop
    const { rows: usoRows } = await pool.query(
      `select count(*)::int as total from crm_whatsapp_disparos
       where tenant_id = $1 and status = 'enviado' and criado_em > now() - interval '24 hours'`,
      [tenantId]
    );
    const usados = usoRows[0].total;
    const restante = limite - usados;
    if (restante > Math.max(10, Math.floor(limite * 0.2))) continue; // longe do limite, não avisa

    // eslint-disable-next-line no-await-in-loop
    const { rows: jaAvisouHoje } = await pool.query(
      `select 1 from crm_notificacoes_eventos
       where tenant_id = $1 and chave = 'whatsapp_limite_proximo' and criado_em::date = current_date limit 1`,
      [tenantId]
    );
    if (jaAvisouHoje[0]) continue;

    // eslint-disable-next-line no-await-in-loop
    await dispararNotificacaoEvento(pool, tenantId, 'whatsapp_limite_proximo', {
      titulo: 'Limite de disparos do WhatsApp quase atingido',
      detalhe: `Restam aproximadamente ${Math.max(restante, 0)} de ${limite} conversas que podem ser iniciadas nas próximas 24h, segundo a Meta.`,
    });
  }
}

// Chamado por setInterval em index.js (a cada hora — granularidade de dia,
// não precisa de mais frequência que isso).
async function checarGatilhosPeriodicos(pool) {
  await checarPedidosParados(pool).catch((err) => console.error(`[automacoes] falha ao checar pedidos parados: ${err.message}`));
  await checarAniversariantes(pool).catch((err) => console.error(`[automacoes] falha ao checar aniversariantes: ${err.message}`));
  await checarLimiteDisparos(pool).catch((err) => console.error(`[automacoes] falha ao checar limite de disparos: ${err.message}`));
}

module.exports = {
  // Helpers de envio reaproveitados pelas campanhas (lib/campanhas.js).
  buscarPhoneNumberId, enviadoRecentemente, registrarEnvio, registrarDisparo, buscarLimiteMensagens,
  GATILHOS_VALIDOS, dispararMudancaEtapa, dispararPedidoCriado,
  checarPedidosParados, checarAniversariantes, checarLimiteDisparos, checarGatilhosPeriodicos,
  montarParametros, renderizarCorpoTemplate,
};
