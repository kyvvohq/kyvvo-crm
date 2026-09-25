// Motor de automação por gatilho (issue #40) — versão enxuta do
// kyvvo-people/lib/automacoes.js: só canal WhatsApp, sem trava de plano
// (o CRM não tem catálogo de planos ainda) e só funciona pra tenant com
// número vinculado em crm_whatsapp_numeros (V1, hoje só a Basic — decisão
// confirmada com o Bruno em 2026-09-25, "vamos alterar isso em breve").
const { enviarTemplate, listarTemplates } = require('@kyvvohq/whatsapp');

const GATILHOS_VALIDOS = ['mudanca_etapa', 'pedido_criado', 'pedido_parado', 'aniversario_cliente'];

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

    const templates = await listarTemplates();
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

// Chamado por setInterval em index.js (a cada hora — granularidade de dia,
// não precisa de mais frequência que isso).
async function checarGatilhosPeriodicos(pool) {
  await checarPedidosParados(pool).catch((err) => console.error(`[automacoes] falha ao checar pedidos parados: ${err.message}`));
  await checarAniversariantes(pool).catch((err) => console.error(`[automacoes] falha ao checar aniversariantes: ${err.message}`));
}

module.exports = {
  GATILHOS_VALIDOS, dispararMudancaEtapa, dispararPedidoCriado,
  checarPedidosParados, checarAniversariantes, checarGatilhosPeriodicos,
  montarParametros, renderizarCorpoTemplate,
};
