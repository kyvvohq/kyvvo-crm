// Campanhas do CRM: disparo de mensagem por WhatsApp (modelo aprovado na Meta)
// ou e-mail pra um público segmentado (lib/segmentos.js), e sorteio de brinde
// ou desconto entre os clientes desse público, com aviso aos ganhadores.
// A campanha vive em crm_segmentos (ver db/030_campanhas.sql); o resultado de
// cada destinatário vai pra crm_campanhas_envios.
const crypto = require('node:crypto');
const whatsapp = require('@kyvvohq/whatsapp');
const { enviarEmail } = require('./email');
const { resolverSegmento } = require('./segmentos');
const automacoes = require('./automacoes');
const creditos = require('./creditos');

const TIPOS = ['disparo', 'sorteio'];
const CANAIS = ['whatsapp', 'email'];
const TIPOS_PREMIO = ['brinde', 'desconto_percentual', 'desconto_valor'];

// Teto por campanha — protege o número de WhatsApp (tier da Meta) e o provedor
// de e-mail de um clique errado num público gigante.
const MAX_DESTINATARIOS = 2000;
const MAX_VENCEDORES = 500;
const LOTE_ENVIO = 5;

function texto(valor) {
  const t = String(valor == null ? '' : valor).trim();
  return t || null;
}

function primeiroNome(nome) {
  return (String(nome || '').trim().split(/\s+/)[0]) || '';
}

function formatarReais(valor) {
  return Number(valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// "Brinde: caneca", "20% de desconto", "R$ 50,00 de desconto" — texto que vai
// na mensagem aos ganhadores ({{premio}}) e na tela.
function formatarPremio(c) {
  if (!c || !c.premio_tipo) return '';
  const extra = c.premio_descricao ? ` — ${c.premio_descricao}` : '';
  if (c.premio_tipo === 'brinde') return c.premio_descricao || 'Brinde';
  if (c.premio_tipo === 'desconto_percentual') return `${Number(c.premio_valor)}% de desconto${extra}`;
  return `${formatarReais(c.premio_valor)} de desconto${extra}`;
}

// Variáveis aceitas no texto do e-mail e nos parâmetros do modelo do WhatsApp.
// `cliente` = nome completo (mesmo nome de parâmetro que as automações usam).
function dadosDoCliente(cliente, premioTexto) {
  return {
    nome: primeiroNome(cliente.nome),
    nome_completo: cliente.nome || '',
    cliente: cliente.nome || '',
    premio: premioTexto || '',
  };
}

function aplicarVariaveis(modelo, dados) {
  return String(modelo || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, chave) => (dados[chave] != null ? String(dados[chave]) : ''));
}

function escaparHtml(valor) {
  return String(valor == null ? '' : valor).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function corpoEmailHtml(textoPuro) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a">${escaparHtml(textoPuro).replace(/\r?\n/g, '<br>')}</div>`;
}

// Valida e normaliza o corpo de POST/PATCH. `erro` volta como texto pra tela.
function normalizarCampanha(body) {
  const b = body || {};
  const nome = texto(b.nome);
  if (!nome) return { erro: 'Nome é obrigatório' };

  const tipo = b.tipo || 'disparo';
  if (!TIPOS.includes(tipo)) return { erro: `Tipo inválido. Válidos: ${TIPOS.join(', ')}` };

  const canal = b.canal || null;
  if (canal && !CANAIS.includes(canal)) return { erro: `Canal inválido. Válidos: ${CANAIS.join(', ')}` };

  const filtros = b.filtros && typeof b.filtros === 'object' && !Array.isArray(b.filtros) ? b.filtros : {};
  const valores = {
    nome, tipo, canal, filtros,
    whatsapp_template: texto(b.whatsapp_template),
    assunto: texto(b.assunto),
    corpo: texto(b.corpo),
    premio_tipo: null, premio_descricao: null, premio_valor: null, qtd_vencedores: null,
    notificar_vencedores: b.notificar_vencedores !== false,
  };

  if (tipo === 'sorteio') {
    if (!TIPOS_PREMIO.includes(b.premio_tipo)) return { erro: 'Escolha o prêmio do sorteio (brinde ou desconto).' };
    valores.premio_tipo = b.premio_tipo;
    valores.premio_descricao = texto(b.premio_descricao);
    if (b.premio_tipo === 'brinde') {
      if (!valores.premio_descricao) return { erro: 'Descreva o brinde.' };
    } else {
      const valor = Number(b.premio_valor);
      if (!(valor > 0)) return { erro: 'Informe o valor do desconto.' };
      if (b.premio_tipo === 'desconto_percentual' && valor > 100) return { erro: 'O desconto percentual não pode passar de 100%.' };
      valores.premio_valor = Math.round(valor * 100) / 100;
    }
    const qtd = b.qtd_vencedores == null || b.qtd_vencedores === '' ? 1 : Number(b.qtd_vencedores);
    if (!Number.isInteger(qtd) || qtd < 1 || qtd > MAX_VENCEDORES) return { erro: `Quantidade de vencedores deve ser de 1 a ${MAX_VENCEDORES}.` };
    valores.qtd_vencedores = qtd;
  }
  return { valores };
}

// O conteúdo da mensagem (disparo ou aviso do sorteio) está completo pro canal?
function erroConteudo(campanha) {
  if (!campanha.canal) return 'Escolha o canal (WhatsApp ou e-mail).';
  if (campanha.canal === 'whatsapp' && !campanha.whatsapp_template) return 'Escolha o modelo de mensagem aprovado.';
  if (campanha.canal === 'email' && (!campanha.assunto || !campanha.corpo)) return 'Preencha o assunto e o texto do e-mail.';
  return null;
}

function embaralharSeguro(lista) {
  const copia = [...lista];
  for (let i = copia.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia;
}

// Parâmetros do corpo do modelo. Nomeado ({{cliente}}, {{premio}}...) casa por
// nome; posicional ({{1}}, {{2}}) recebe [cliente, prêmio] na ordem, cortado ou
// completado com vazio pra bater com a contagem que o modelo espera.
function montarParametrosModelo(modelo, dados) {
  if (modelo && modelo.parametros_nomeados) {
    return modelo.parametros_corpo.map((nome) => ({ nome, nomeado: true, valor: dados[nome] != null ? String(dados[nome]) : '' }));
  }
  const qtd = modelo && Array.isArray(modelo.parametros_corpo) ? modelo.parametros_corpo.length : 1;
  const valores = [dados.cliente, dados.premio];
  return Array.from({ length: qtd }, (_, i) => ({ nomeado: false, valor: valores[i] != null ? String(valores[i]) : '' }));
}

async function registrarResultado(pool, { tenantId, campanhaId, clienteId, finalidade, canal, destino, status, motivo }) {
  await pool.query(
    `insert into crm_campanhas_envios (tenant_id, campanha_id, cliente_id, finalidade, canal, destino, status, motivo)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tenantId, campanhaId, clienteId || null, finalidade, canal, destino || null, status, motivo || null]
  );
}

// Manda a mensagem da campanha pra cada cliente da lista e registra o resultado
// de cada um. `finalidade`: 'disparo' (a campanha em si) ou 'sorteio' (aviso aos
// ganhadores — não passa pela trava de 1 mensagem por dia, o ganhador precisa
// ser avisado). Nunca lança por causa de um cliente; só falha de configuração
// (WhatsApp sem número) sobe como exceção, antes de enviar qualquer coisa.
async function enviarParaClientes(pool, { tenantId, campanha, clientes, finalidade = 'disparo', premioTexto = '', deps = {} }) {
  const d = {
    enviarTemplate: whatsapp.enviarTemplate,
    listarTemplates: whatsapp.listarTemplates,
    enviarEmail,
    ...deps,
  };
  const canal = campanha.canal;
  const gatilho = finalidade === 'sorteio' ? 'sorteio' : 'campanha';
  const resultado = { enviados: 0, erros: 0, ignorados: 0 };

  let phoneNumberId = null;
  let modelo = null;
  if (canal === 'whatsapp') {
    phoneNumberId = await automacoes.buscarPhoneNumberId(pool, tenantId);
    if (!phoneNumberId) throw new Error('WhatsApp não conectado — conecte o número em Configurações > WhatsApp.');
    const modelos = await d.listarTemplates();
    modelo = modelos.find((m) => m.nome === campanha.whatsapp_template) || null;
  }

  async function enviarUm(cliente) {
    const dados = dadosDoCliente(cliente, premioTexto);
    if (cliente.bloqueado) return { status: 'ignorado', motivo: 'Cliente bloqueado' };

    if (canal === 'whatsapp') {
      if (!cliente.telefone) return { status: 'ignorado', motivo: 'Sem telefone' };
      if (finalidade === 'disparo' && await automacoes.enviadoRecentemente(pool, cliente.telefone)) {
        await automacoes.registrarDisparo(pool, { tenantId, telefoneE164: cliente.telefone, templateNome: campanha.whatsapp_template, gatilho, status: 'bloqueado_24h' });
        return { status: 'ignorado', motivo: 'Já recebeu uma mensagem nas últimas 24h', destino: cliente.telefone };
      }

      // Mesma trava de créditos das automações (lib/creditos.js) — envio de
      // campanha/sorteio também é 1 mensagem de template da Meta, mesmo custo
      // (pedido do Bruno, 2026-10-21: "envios individuais tbm devem ser
      // contabilizados no consumo e no histórico").
      const saldo = await creditos.obterSaldo(pool, tenantId);
      if (saldo.saldoTotal <= 0) {
        await automacoes.registrarDisparo(pool, { tenantId, telefoneE164: cliente.telefone, templateNome: campanha.whatsapp_template, gatilho, status: 'sem_creditos' });
        return { status: 'ignorado', motivo: 'Sem créditos de WhatsApp disponíveis', destino: cliente.telefone };
      }

      const parametrosCorpo = montarParametrosModelo(modelo, dados);
      const mensagemTexto = automacoes.renderizarCorpoTemplate(modelo && modelo.corpo, parametrosCorpo);
      const ok = await d.enviarTemplate({ to: cliente.telefone, templateName: campanha.whatsapp_template, parametrosCorpo, phoneNumberId });
      if (ok) {
        // Grava o disparo ANTES do registro de 24h/débito de crédito — mesmo
        // cuidado do fix em lib/automacoes.js (2026-10-21): um envio que a
        // Meta já aceitou não pode sumir do histórico por causa de uma falha
        // num efeito colateral best-effort depois dele.
        await automacoes.registrarDisparo(pool, { tenantId, telefoneE164: cliente.telefone, templateNome: campanha.whatsapp_template, gatilho, status: 'enviado', mensagemTexto });
        await automacoes.registrarEnvio(pool, tenantId, cliente.telefone).catch((err) => console.error(`[campanhas] falha ao registrar envio (24h) da campanha ${campanha.id}: ${err.message}`));
        await creditos.debitar(pool, tenantId).catch((err) => console.error(`[campanhas] falha ao debitar crédito da campanha ${campanha.id}: ${err.message}`));
      } else {
        await automacoes.registrarDisparo(pool, { tenantId, telefoneE164: cliente.telefone, templateNome: campanha.whatsapp_template, gatilho, status: 'erro', mensagemTexto });
      }
      return ok
        ? { status: 'enviado', destino: cliente.telefone }
        : { status: 'erro', motivo: 'A Meta recusou o envio (confira se o modelo está aprovado)', destino: cliente.telefone };
    }

    // e-mail
    if (!cliente.email) return { status: 'ignorado', motivo: 'Sem e-mail' };
    const corpoFinal = aplicarVariaveis(campanha.corpo, dados);
    const ok = await d.enviarEmail({
      to: cliente.email,
      subject: aplicarVariaveis(campanha.assunto, dados),
      text: corpoFinal,
      html: corpoEmailHtml(corpoFinal),
      tag: finalidade === 'sorteio' ? 'campanha-sorteio' : 'campanha',
    });
    return ok
      ? { status: 'enviado', destino: cliente.email }
      : { status: 'erro', motivo: 'O provedor de e-mail não aceitou o envio', destino: cliente.email };
  }

  for (let i = 0; i < clientes.length; i += LOTE_ENVIO) {
    const lote = clientes.slice(i, i + LOTE_ENVIO);
    // eslint-disable-next-line no-await-in-loop
    const respostas = await Promise.all(lote.map((c) => enviarUm(c).catch((err) => ({ status: 'erro', motivo: err.message }))));
    for (let k = 0; k < lote.length; k += 1) {
      const r = respostas[k];
      if (r.status === 'enviado') resultado.enviados += 1;
      else if (r.status === 'erro') resultado.erros += 1;
      else resultado.ignorados += 1;
      // eslint-disable-next-line no-await-in-loop
      await registrarResultado(pool, { tenantId, campanhaId: campanha.id, clienteId: lote[k].id, finalidade, canal, destino: r.destino, status: r.status, motivo: r.motivo });
    }
  }
  return resultado;
}

// Confere tudo que dá pra conferir antes de disparar: conteúdo, público,
// WhatsApp conectado/modelo aprovado e o limite de conversas da Meta nas
// próximas 24h. Devolve { erro } ou { clientes } (já sem bloqueados).
async function prepararDisparo(pool, { tenantId, campanha, deps = {} }) {
  if (campanha.tipo !== 'disparo') return { erro: 'Esta campanha é um sorteio — use "Sortear".' };
  if (campanha.status === 'enviando') return { erro: 'Esta campanha está sendo enviada agora.', status: 409 };
  if (campanha.status === 'enviada') return { erro: 'Esta campanha já foi enviada. Duplique-a para enviar de novo.', status: 409 };
  const erroMsg = erroConteudo(campanha);
  if (erroMsg) return { erro: erroMsg };

  const todos = await resolverSegmento(pool, tenantId, campanha.filtros);
  const clientes = todos.filter((c) => !c.bloqueado);
  if (!clientes.length) return { erro: 'Nenhum cliente no público desta campanha.' };
  if (clientes.length > MAX_DESTINATARIOS) return { erro: `O público tem ${clientes.length} clientes — o máximo por campanha é ${MAX_DESTINATARIOS}. Refine os filtros.` };

  if (campanha.canal === 'whatsapp') {
    const phoneNumberId = await automacoes.buscarPhoneNumberId(pool, tenantId);
    if (!phoneNumberId) return { erro: 'WhatsApp não conectado — conecte o número em Configurações > WhatsApp.' };
    const listar = deps.listarTemplates || whatsapp.listarTemplates;
    const modelos = await listar();
    const modelo = modelos.find((m) => m.nome === campanha.whatsapp_template);
    if (modelos.length && (!modelo || modelo.status !== 'APPROVED')) return { erro: `O modelo "${campanha.whatsapp_template}" não está aprovado na Meta.` };

    const comTelefone = clientes.filter((c) => c.telefone).length;
    const buscarLimite = deps.buscarLimiteMensagens || automacoes.buscarLimiteMensagens;
    const limite = await buscarLimite(phoneNumberId);
    if (limite) {
      const { rows } = await pool.query(
        `select count(*)::int as total from crm_whatsapp_disparos
         where tenant_id = $1 and status = 'enviado' and criado_em > now() - interval '24 hours'`,
        [tenantId]
      );
      const restante = Math.max(limite - rows[0].total, 0);
      if (comTelefone > restante) {
        return { erro: `Seu número pode iniciar cerca de ${limite} conversas por dia e restam ${restante} nas próximas 24h, mas esta campanha tem ${comTelefone} destinatários com WhatsApp. Reduza o público ou envie outro dia.` };
      }
    }
  }
  return { clientes };
}

// Roda o disparo em segundo plano (a rota responde 202 antes). Fecha a
// campanha como 'enviada'; se nada chegou a ser registrado (falha antes de
// enviar), volta pra rascunho pra a pessoa poder tentar de novo.
async function executarDisparo(pool, { tenantId, campanha, clientes, deps = {} }) {
  try {
    await enviarParaClientes(pool, { tenantId, campanha, clientes, finalidade: 'disparo', deps });
    await pool.query(`update crm_segmentos set status = 'enviada', atualizado_em = now() where id = $1`, [campanha.id]);
  } catch (err) {
    console.error(`[campanhas] falha ao enviar campanha ${campanha.id}: ${err.message}`);
    const { rows } = await pool.query(`select 1 from crm_campanhas_envios where campanha_id = $1 and finalidade = 'disparo' limit 1`, [campanha.id]);
    await pool.query('update crm_segmentos set status = $2, atualizado_em = now() where id = $1', [campanha.id, rows[0] ? 'enviada' : 'rascunho']);
  }
}

// Sorteia entre o público (sem bloqueados), guarda a lista congelada e o prêmio
// e, se a campanha pedir, avisa os ganhadores. O sorteio é gravado ANTES do
// aviso — o resultado fica registrado mesmo que o envio falhe.
async function sortearCampanha(pool, { tenantId, userId, campanha, quantidade, notificar, deps = {} }) {
  const participantes = (await resolverSegmento(pool, tenantId, campanha.filtros)).filter((c) => !c.bloqueado);
  if (!participantes.length) return { erro: 'Esta campanha não tem nenhum participante agora.' };

  const pedida = Number(quantidade) || campanha.qtd_vencedores || 1;
  const qtd = Math.min(Math.max(Math.floor(pedida), 1), participantes.length);
  const ganhadores = embaralharSeguro(participantes).slice(0, qtd);
  const vencedores = ganhadores.map((c) => ({ id: c.id, nome: c.nome, telefone: c.telefone, email: c.email }));

  const premioTexto = formatarPremio(campanha);
  const premio = campanha.premio_tipo
    ? { tipo: campanha.premio_tipo, descricao: campanha.premio_descricao, valor: campanha.premio_valor == null ? null : Number(campanha.premio_valor), texto: premioTexto }
    : null;

  const { rows } = await pool.query(
    `insert into crm_sorteios (tenant_id, segmento_id, participantes, vencedores, ator_id, premio)
     values ($1, $2, $3, $4, $5, $6) returning *`,
    [tenantId, campanha.id, JSON.stringify(participantes.map((c) => c.id)), JSON.stringify(vencedores), userId, premio ? JSON.stringify(premio) : null]
  );
  let sorteio = rows[0];

  const deveAvisar = (notificar == null ? campanha.notificar_vencedores : notificar) && campanha.canal && !erroConteudo(campanha);
  if (deveAvisar) {
    let notificacao;
    try {
      const r = await enviarParaClientes(pool, { tenantId, campanha, clientes: ganhadores, finalidade: 'sorteio', premioTexto, deps });
      notificacao = { canal: campanha.canal, ...r };
    } catch (err) {
      notificacao = { canal: campanha.canal, enviados: 0, erros: ganhadores.length, ignorados: 0, erro: err.message };
    }
    const upd = await pool.query('update crm_sorteios set notificacao = $2 where id = $1 returning *', [sorteio.id, JSON.stringify(notificacao)]);
    sorteio = upd.rows[0] || { ...sorteio, notificacao };
  }

  await pool.query(
    `update crm_segmentos set status = 'sorteada', total_publico = $2, atualizado_em = now() where id = $1`,
    [campanha.id, participantes.length]
  );
  return { sorteio };
}

module.exports = {
  TIPOS, CANAIS, TIPOS_PREMIO, MAX_DESTINATARIOS,
  normalizarCampanha, erroConteudo, formatarPremio, aplicarVariaveis, dadosDoCliente,
  montarParametrosModelo, embaralharSeguro,
  enviarParaClientes, prepararDisparo, executarDisparo, sortearCampanha,
};
