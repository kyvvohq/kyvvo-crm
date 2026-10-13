require('dotenv').config();

const path = require('path');
const fs = require('fs');
const Fastify = require('fastify');
const fastifyStatic = require('@fastify/static');
const fastifyMultipart = require('@fastify/multipart');

const { pool, migrar } = require('./lib/db');
const { paraE164 } = require('./lib/telefone');
const { encontrarOuCriarPorTelefone, buscarMetricas } = require('./lib/clientes');
const { proximoNumeroPedido } = require('./lib/pedidos');
const { inicializarModelosPadrao } = require('./lib/mensagens');
const { resolverSegmento } = require('./lib/segmentos');
const campanhas = require('./lib/campanhas');
const { inicializarEtapasPadrao, buscarEtapaPronto } = require('./lib/etapas');
const { buscarSugestoesDuplicados, mesclarClientes } = require('./lib/duplicados');
const { parseCsv, importarClientesCsv, processarImportacaoNfeEmSegundoPlano } = require('./lib/importacoes');
const { tenantPrecisaOnboarding, confirmarOnboarding } = require('./lib/onboarding');
const { processarMensagem, registrarMensagem, textoDaEntrada, textoDoEnvio, checarConversasParaRetomar } = require('./lib/bot-whatsapp');
const { DIR_UPLOADS } = require('./lib/whatsapp-media');
const { enviarTexto, enviarBotoes, enviarLista, listarTemplates } = require('@kyvvohq/whatsapp');
const { dispararMudancaEtapa, dispararPedidoCriado, checarGatilhosPeriodicos, GATILHOS_VALIDOS } = require('./lib/automacoes');
const { provisionarWhatsapp } = require('./lib/provisionamento-whatsapp');
const metaWhatsappService = require('./lib/meta-whatsapp-service');
const { relatorioPedidos, listarPedidosDetalhado } = require('./lib/relatorios');
const { novoDocumentoRelatorio, desenharResumo, desenharTabela, formatarMoedaPdf } = require('./lib/pdf-relatorios');
const { enviarEmail } = require('./lib/email');
const {
  listarNotificacoesPendentes, marcarNotificacaoLida, marcarTodasNotificacoesLidas, listarHistoricoNotificacoes,
  dispararNotificacaoEvento,
} = require('./lib/notificacoes');
const { criarAgente } = require('./lib/agente');
const atendimento = require('./lib/agente/atendimento');
const platform = require('./lib/platform');
const { resolverClaims } = require('./lib/resolver-sessao');

const PORT = process.env.PORT || 3005;

// Identidade/sessão: kyvvo-platform, mesmo serviço que Studio e People usam
// (endereço interno na rede do compose). O token RS256 do platform é a
// própria sessão (corte unificado) — o CRM não assina mais JWT nenhum.
const PLATFORM_URL = process.env.PLATFORM_URL || 'http://platform:3003';

// "Trocar de produto" no menu de perfil: outros produtos Kyvvo que o mesmo
// tenant também tem ativo (ex.: um salão que também usa o CRM). Resolvido
// uma vez no login (não a cada request) usando o token RS256 do kyvvo-
// platform que já temos em mãos naquele momento — o resultado já filtrado
// vai pro front, que cacheia em localStorage (o token RS256 do platform em
// si não carrega mais essa lista).
const PRODUTOS_CRUZADOS_CRM = {
  agenda_inteligente: { chave: 'studio', nome: 'Studio', url: 'https://studio.kyvvo.com.br' },
  people: { chave: 'people', nome: 'People', url: 'https://people.kyvvo.com.br' },
};

// Login automático ao trocar de produto (handoff via kyvvo-platform, ver
// kyvvo-platform/routes/handoff.js e o par simétrico em kyvvo-studio/
// kyvvo-people). Mesmo INTERNAL_HANDOFF_TOKEN precisa estar configurado nos
// 4 serviços — sem ele, o platform recusa a chamada e o link cai pra landing
// pública do produto (best-effort, nunca trava o clique).
const PRODUTOS_HANDOFF_DESTINO = {
  studio: 'https://studio.kyvvo.com.br/sso',
  people: 'https://people.kyvvo.com.br/people/sso',
};

async function build(opcoes = {}) {
  const fastify = Fastify({ logger: true });
  // Agente de IA (Fase 2). `opcoes.agente` permite injetar dependências nos testes.
  fastify.decorate('agente', opcoes.agente || criarAgente(pool));

  // Sessão não é mais JWT local assinado pelo CRM: o kyvvo-platform é a
  // única autoridade de auth (mesmo corte já feito no Studio/People) —
  // token RS256 verificado local via @kyvvohq/platform-client (JWKS, sem
  // round-trip). CRM não tem token_version/role nem bloqueio por
  // assinatura local (não é regressão — o JWT de 12h anterior também não
  // tinha revogação nenhuma).
  fastify.decorate('authenticate', async (request, reply) => {
    const claims = await resolverClaims({
      authorizationHeader: request.headers.authorization,
      verificarRs256: (token) => platform.verifyToken(token),
    });
    if (!claims) {
      return reply.code(401).send({ error: 'Não autenticado' });
    }
    request.user = claims;
  });

  fastify.register(fastifyStatic, {
    root: path.join(__dirname, 'public'),
    prefix: '/crm/',
  });

  // `files` subiu de 20 pra 300 — a importação de NF-e processa em segundo
  // plano agora (fila, ver /crm/api/importacoes/nfe), não tem mais motivo
  // pra limitar quantos arquivos o usuário manda de uma vez.
  fastify.register(fastifyMultipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 300 },
  });

  fastify.get('/', async (request, reply) => reply.sendFile('index.html'));

  fastify.get('/crm/api/saude', async () => ({ ok: true }));

  // --- Bot de atendimento por WhatsApp (US pedida pelo Bruno, 2026-09-24:
  // agente exclusivo da Basic 3D Print) ---------------------------------
  // Encaminhado pelo kyvvo-platform (único destino cadastrado na Meta pra
  // Kyvvo inteira, ver kyvvo-platform/routes/webhook-whatsapp.js) — nunca
  // aberto pra Meta direto, por isso o segredo em vez de handshake próprio.
  // Resolve o tenant pelo phone_number_id (crm_whatsapp_numeros) em vez de
  // um único tenant fixo — permite mais de um CRM com bot dedicado sem
  // redeploy. Sempre 200 pra Meta, mesmo em erro (mesmo padrão de
  // People/Studio): a Meta desativa o webhook depois de falhas repetidas.
  // Traduz o shape de mensagem da Meta pra entrada do bot — null quando o
  // tipo não é suportado no fluxo (áudio, figurinha, localização etc.),
  // que o handler simplesmente ignora em vez de travar a conversa.
  function extrairEntradaBot(msg) {
    if (msg.type === 'text') return { tipo: 'texto', texto: (msg.text || {}).body || '' };
    if (msg.type === 'interactive' && msg.interactive && msg.interactive.type === 'button_reply') {
      return { tipo: 'botao', id: msg.interactive.button_reply.id };
    }
    // Clique numa mensagem de lista (interactive/list) — mesma forma que um
    // clique de botão pro bot (só id importa), mas a Meta manda num campo
    // diferente (list_reply em vez de button_reply).
    if (msg.type === 'interactive' && msg.interactive && msg.interactive.type === 'list_reply') {
      return { tipo: 'botao', id: msg.interactive.list_reply.id };
    }
    if (msg.type === 'document' && msg.document) {
      return { tipo: 'arquivo', mediaId: msg.document.id, nomeArquivo: msg.document.filename || null };
    }
    if (msg.type === 'image' && msg.image) {
      return { tipo: 'arquivo', mediaId: msg.image.id, nomeArquivo: null };
    }
    return null;
  }

  fastify.post('/crm/api/webhook/whatsapp', async (request, reply) => {
    if (!process.env.WEBHOOK_INTERNAL_SECRET || request.headers['x-webhook-internal-secret'] !== process.env.WEBHOOK_INTERNAL_SECRET) {
      return reply.code(401).send({ error: 'Segredo interno inválido' });
    }
    try {
      const body = request.body || {};
      // Números com agente ligado (crm_agente_config.modo <> 'desligado') são
      // tratados pelo agente: grava e responde 200; o resto roda em segundo
      // plano. Os demais seguem no bot por lista abaixo, sem mudança.
      const { tratados } = await fastify.agente.tratarWebhook(body);
      const change = (((body.entry || [])[0] || {}).changes || [])[0];
      const value = change ? change.value : null;
      const phoneNumberId = value && value.metadata && value.metadata.phone_number_id;
      const msg = value && (value.messages || [])[0];
      const entrada = msg ? extrairEntradaBot(msg) : null;
      // Meta manda o nome do perfil do contato em quase toda mensagem — só é
      // usado se o cliente ainda não tiver cadastro (ver encontrarOuCriarPorTelefone).
      const nomeWhatsapp = value && Array.isArray(value.contacts) && value.contacts[0] && value.contacts[0].profile
        ? value.contacts[0].profile.name : null;

      if (entrada && phoneNumberId && !tratados.has(phoneNumberId)) {
        const { rows } = await pool.query('select tenant_id from crm_whatsapp_numeros where phone_number_id = $1', [phoneNumberId]);
        const tenantId = rows[0] && rows[0].tenant_id;
        const telefoneE164 = tenantId ? paraE164(msg.from) : null;

        if (!tenantId) {
          request.log.warn(`[bot-whatsapp] phone_number_id ${phoneNumberId} sem tenant vinculado (crm_whatsapp_numeros) — mensagem ignorada`);
        } else if (telefoneE164) {
          registrarMensagem(pool, { tenantId, telefoneE164, direcao: 'recebida', tipo: entrada.tipo, conteudo: textoDaEntrada(entrada) });
          const envios = await processarMensagem(pool, { tenantId, telefoneE164, entrada, nomeWhatsapp });
          for (const envio of envios) {
            if (envio.tipo === 'botoes') {
              await enviarBotoes({ to: telefoneE164, texto: envio.texto, botoes: envio.botoes, phoneNumberId });
            } else if (envio.tipo === 'lista') {
              await enviarLista({ to: telefoneE164, texto: envio.texto, tituloBotao: envio.tituloBotao, opcoes: envio.opcoes, phoneNumberId });
            } else {
              await enviarTexto({ to: telefoneE164, texto: envio.texto, phoneNumberId });
            }
            registrarMensagem(pool, { tenantId, telefoneE164, direcao: 'enviada', tipo: envio.tipo, conteudo: textoDoEnvio(envio) });
          }
        }
      }
    } catch (err) {
      request.log.error(`[bot-whatsapp] Falha ao processar: ${err.message}`);
    }
    return reply.code(200).send({ ok: true });
  });

  // --- Vínculo phone_number_id -> tenant, gerenciado pelo kyvvo-admin ------
  // Até aqui (2026-09-25) esse vínculo só existia via INSERT manual direto
  // no banco (ver docs/DECISOES-PENDENTES.md #3 e o comentário em
  // db/005_whatsapp_bot.sql) — pedido do Bruno pra ter uma tela em vez disso.
  // Protegido por segredo compartilhado (ADMIN_INTERNAL_TOKEN, mesmo valor
  // cadastrado no kyvvo-admin/kyvvo-people), não por fastify.authenticate —
  // mesmo padrão de People (`/people/admin-interno/*`), nunca exposto
  // publicamente, só alcançável dentro da rede Docker/EC2.
  function autenticarAdminInterno(request, reply) {
    const token = (request.headers['x-admin-internal-token'] || '').trim();
    if (!process.env.ADMIN_INTERNAL_TOKEN || token !== process.env.ADMIN_INTERNAL_TOKEN) {
      reply.code(401).send({ error: 'Não autorizado' });
      return false;
    }
    return true;
  }

  fastify.get('/crm/admin-interno/whatsapp-numeros', async (request, reply) => {
    if (!autenticarAdminInterno(request, reply)) return;
    const { rows } = await pool.query('select phone_number_id, tenant_id, numero_exibido, criado_em from crm_whatsapp_numeros order by criado_em desc');
    return { numeros: rows };
  });

  fastify.post('/crm/admin-interno/whatsapp-numeros', async (request, reply) => {
    if (!autenticarAdminInterno(request, reply)) return;
    const { phone_number_id: phoneNumberId, tenant_id: tenantId, numero_exibido: numeroExibido } = request.body || {};
    if (!phoneNumberId || !tenantId) {
      return reply.code(400).send({ error: 'phone_number_id e tenant_id são obrigatórios' });
    }
    const { rows } = await pool.query(
      `insert into crm_whatsapp_numeros (phone_number_id, tenant_id, numero_exibido)
       values ($1, $2, $3)
       on conflict (phone_number_id) do update set tenant_id = excluded.tenant_id,
         numero_exibido = coalesce(excluded.numero_exibido, crm_whatsapp_numeros.numero_exibido)
       returning *`,
      [phoneNumberId, tenantId, numeroExibido || null]
    );
    return reply.code(201).send(rows[0]);
  });

  fastify.delete('/crm/admin-interno/whatsapp-numeros/:phoneNumberId', async (request, reply) => {
    if (!autenticarAdminInterno(request, reply)) return;
    await pool.query('delete from crm_whatsapp_numeros where phone_number_id = $1', [request.params.phoneNumberId]);
    return { ok: true };
  });

  // Leitura do modo do agente (desligado/rascunho/automatico) por tenant —
  // suporte pediu pra diagnosticar "bot não responde" sem precisar de query
  // manual no banco (achado ao vivo, 2026-10-13: ver admin > WABAs).
  fastify.get('/crm/admin-interno/agente-config/:tenantId', async (request, reply) => {
    if (!autenticarAdminInterno(request, reply)) return;
    const config = await atendimento.obterConfig(pool, request.params.tenantId);
    return config;
  });

  // Troca o modo pelo admin (sem usuário do tenant logado, por isso
  // ator_id fica null em crm_eventos — definirModo já trata esse caso).
  fastify.put('/crm/admin-interno/agente-config/:tenantId', async (request, reply) => {
    if (!autenticarAdminInterno(request, reply)) return;
    const { modo } = request.body || {};
    try {
      return await atendimento.definirModo(pool, request.params.tenantId, null, modo);
    } catch (erro) {
      if (erro instanceof atendimento.ErroAtendimento) return reply.code(erro.status).send({ error: erro.message });
      throw erro;
    }
  });

  // Diagnóstico de "bot não responde" — tudo numa chamada: canal (número +
  // modo/status), últimas mensagens (chegou? foi enviada resposta?) e
  // últimas execuções do agente (rodou? bloqueou no filtro? qual motivo?).
  // Sem isso cada suspeita vira um round-trip de SQL manual no banco.
  fastify.get('/crm/admin-interno/diagnostico-whatsapp/:tenantId', async (request, reply) => {
    if (!autenticarAdminInterno(request, reply)) return;
    const { tenantId } = request.params;
    const [canalRows, mensagensRows, conversasRows, execucoesRows] = await Promise.all([
      pool.query('select phone_number_id, modo, status, numero_exibido from crm_whatsapp_numeros where tenant_id = $1', [tenantId]),
      pool.query(
        `select telefone_e164, direcao, tipo, autor, status_entrega, processada_em, tentativas, criado_em
           from crm_mensagens_whatsapp where tenant_id = $1 order by criado_em desc limit 10`,
        [tenantId],
      ),
      pool.query(
        `select telefone_e164, situacao, ultima_msg_cliente_em, janela_expira_em, pausada_ate, atualizado_em
           from crm_conversas_whatsapp where tenant_id = $1 order by atualizado_em desc limit 5`,
        [tenantId],
      ),
      pool.query(
        `select modelo, resposta_proposta is not null as tem_proposta, resposta_enviada is not null as tem_enviada,
                bloqueada_por_filtro, motivo_bloqueio, decisao, criado_em
           from crm_agente_execucoes where tenant_id = $1 order by criado_em desc limit 10`,
        [tenantId],
      ),
    ]);
    return {
      canais: canalRows.rows,
      mensagens_recentes: mensagensRows.rows,
      conversas_recentes: conversasRows.rows,
      execucoes_recentes: execucoesRows.rows,
      // Só presença, nunca o valor — mensagem chega e grava a conversa mesmo
      // sem isso (achado ao vivo, 2026-10-13: zero linhas em
      // crm_agente_execucoes mesmo com mensagem recebida é consistente com
      // executor.js:criarClienteAnthropic lançando ANTES do 1º
      // registrarExecucao — silencioso, só aparece no log do container).
      anthropic_api_key_configurada: Boolean(process.env.ANTHROPIC_API_KEY),
      meta_whatsapp_token_configurado: Boolean(process.env.META_WHATSAPP_TOKEN),
    };
  });

  // --- Conversas (histórico de mensagens do bot, crm_mensagens_whatsapp) ---
  // Configurações > WhatsApp > Conversas. Uma linha por telefone (a mensagem
  // mais recente, pra prévia da lista) — a thread completa vem só ao abrir
  // uma conversa específica (rota de baixo), não precisa vir tudo de uma vez.
  fastify.get('/crm/api/conversas', { preHandler: fastify.authenticate }, async (request) => {
    const { tenantId } = request.user;
    // em_atendimento: existe uma linha ativa em crm_conversas_whatsapp pra
    // esse telefone (bot ainda em algum passo do fluxo) — usado pra status
    // "Em atendimento"/"Concluído" do componente .ds-conversas. O bot do
    // CRM é 100% automático (sem handoff pra humano, ver
    // lib/notificacoes.js#atendimento_bot_travado), então "quem atende"
    // aqui é sempre o bot Kyvvo.
    const { rows } = await pool.query(
      `select distinct on (m.telefone_e164) m.telefone_e164, m.conteudo as ultima_mensagem, m.criado_em as ultima_em, c.nome as cliente_nome,
              exists(select 1 from crm_conversas_whatsapp cw where cw.tenant_id = m.tenant_id and cw.telefone_e164 = m.telefone_e164) as em_atendimento
       from crm_mensagens_whatsapp m
       left join crm_clientes c on c.tenant_id = m.tenant_id and c.telefone = m.telefone_e164
       where m.tenant_id = $1
       order by m.telefone_e164, m.criado_em desc`,
      [tenantId]
    );
    rows.sort((a, b) => new Date(b.ultima_em) - new Date(a.ultima_em));
    return rows;
  });

  fastify.get('/crm/api/conversas/:telefone/mensagens', { preHandler: fastify.authenticate }, async (request) => {
    const { tenantId } = request.user;
    const { rows } = await pool.query(
      `select direcao, tipo, conteudo, criado_em from crm_mensagens_whatsapp
       where tenant_id = $1 and telefone_e164 = $2 order by criado_em asc`,
      [tenantId, request.params.telefone]
    );
    return rows;
  });

  // Disparo manual pra 1 cliente (Painel Hoje — ícone "Disparo individual",
  // pedido do Bruno 2026-10-03): fora do fluxo automático do bot/automações,
  // o operador escreve/edita a mensagem na hora e manda agora. Usa o mesmo
  // número conectado do tenant (crm_whatsapp_numeros) e registra no
  // histórico igual uma mensagem enviada pelo bot (aparece em Conversas).
  fastify.post('/crm/api/disparo-individual', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const { telefone, mensagem } = request.body || {};
    const telefoneE164 = paraE164(telefone);
    if (!telefoneE164 || !mensagem || !mensagem.trim()) {
      return reply.code(400).send({ error: 'Telefone e mensagem são obrigatórios' });
    }
    const { rows } = await pool.query('select phone_number_id from crm_whatsapp_numeros where tenant_id = $1 limit 1', [tenantId]);
    const phoneNumberId = rows[0] && rows[0].phone_number_id;
    if (!phoneNumberId) return reply.code(409).send({ error: 'Nenhum WhatsApp conectado — conecte em Configurações > WhatsApp.' });

    const enviado = await enviarTexto({ to: telefoneE164, texto: mensagem, phoneNumberId });
    if (!enviado) return reply.code(502).send({ error: 'Falha ao enviar a mensagem pelo WhatsApp.' });

    await registrarMensagem(pool, { tenantId, telefoneE164, direcao: 'enviada', tipo: 'texto', conteudo: mensagem });
    return { ok: true };
  });

  // Ícone de e-mail do Painel > Aniversariantes do mês: dispara o e-mail
  // pro cliente (pedido do Bruno, 2026-10-11). Busca o e-mail no cadastro
  // em vez de confiar no que o front manda — defesa simples contra mandar
  // pra um destinatário arbitrário. Usa o layout padrão da plataforma
  // (lib/email.js -> platform /internal/email/send), mesma identidade
  // visual Kyvvo dos outros e-mails do produto.
  fastify.post('/crm/api/clientes/:id/email-aniversario', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const assunto = (request.body?.assunto || '').trim();
    const corpo = (request.body?.corpo || '').trim();
    if (!assunto || !corpo) return reply.code(400).send({ error: 'Assunto e mensagem são obrigatórios' });

    const { rows } = await pool.query('select email from crm_clientes where id = $1 and tenant_id = $2', [request.params.id, tenantId]);
    if (!rows[0]) return reply.code(404).send({ error: 'Cliente não encontrado' });
    if (!rows[0].email) return reply.code(409).send({ error: 'Cliente sem e-mail cadastrado' });

    const enviado = await enviarEmail({
      to: rows[0].email,
      subject: assunto,
      text: corpo,
      tag: 'crm_aniversario',
      layout: { tipo: 'mensagem', titulo: assunto, paragrafos: [corpo] },
    });
    if (!enviado) return reply.code(502).send({ error: 'Falha ao enviar o e-mail.' });
    return { ok: true };
  });

  // --- Self-service de conexão do WhatsApp (Embedded Signup da Meta) -------
  // Mesmo fluxo do kyvvo-studio (server/panel/routes/whatsapp-config.js),
  // adaptado pro modelo multi-número do CRM (crm_whatsapp_numeros em vez de
  // uma coluna em tenants). Fica em Configurações > WhatsApp > Conectar.
  // appId/configId não são secretos — só inicializam o SDK do Facebook no
  // frontend.
  fastify.get('/crm/api/whatsapp/config-publica', { preHandler: fastify.authenticate }, async () => {
    return { appId: process.env.META_APP_ID || null, configId: process.env.META_CONFIG_ID || null };
  });

  fastify.get('/crm/api/whatsapp/status', { preHandler: fastify.authenticate }, async (request) => {
    const { tenantId } = request.user;
    const { rows } = await pool.query('select phone_number_id, numero_exibido from crm_whatsapp_numeros where tenant_id = $1 limit 1', [tenantId]);
    const numero = rows[0];
    if (!numero) return { conectado: false };

    if (!process.env.META_WHATSAPP_TOKEN) {
      return { conectado: false, phoneNumberId: numero.phone_number_id, erro: 'META_WHATSAPP_TOKEN não configurado no servidor.' };
    }
    try {
      const info = await metaWhatsappService.buscarInfoNumero(numero.phone_number_id);
      return {
        conectado: true,
        phoneNumberId: numero.phone_number_id,
        numeroExibido: info.display_phone_number || numero.numero_exibido,
        nomeVerificado: info.verified_name || null,
        qualidade: info.quality_rating || null,
      };
    } catch (erro) {
      return { conectado: false, phoneNumberId: numero.phone_number_id, erro: erro.message };
    }
  });

  // Recebe o resultado do Embedded Signup (code + waba_id + phone_number_id,
  // vindos do postMessage/callback do FB.login no frontend) — ver
  // whatsapp.html. V1: um número por tenant (mesma premissa já usada em
  // lib/automacoes.js#buscarPhoneNumberId) — conectar um número novo troca o
  // anterior, não acumula.
  fastify.post('/crm/api/whatsapp/conectar', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const { code, wabaId, phoneNumberId } = request.body || {};
    if (!code || !wabaId || !phoneNumberId) {
      return reply.code(400).send({ error: 'Dados incompletos retornados pelo WhatsApp. Tente conectar novamente.' });
    }

    let numeroExibido = null;
    try {
      const { access_token: tokenCliente } = await metaWhatsappService.trocarCodePorToken(code);
      await metaWhatsappService.assinarWebhooks(wabaId, tokenCliente);
      try {
        await metaWhatsappService.atribuirUsuarioSistema(wabaId, tokenCliente);
      } catch (erroAtribuicao) {
        // Best-effort — pode depender de aprovação/config pendente do lado da
        // Meta; não impede a conexão de ser salva (mesmo critério do Studio).
        request.log.error(`[whatsapp] falha ao atribuir Usuário do Sistema à waba ${wabaId} do tenant ${tenantId}: ${erroAtribuicao.message}`);
      }
      try {
        await metaWhatsappService.registrarNumero(phoneNumberId);
      } catch (erroRegistro) {
        request.log.error(`[whatsapp] falha ao registrar número ${phoneNumberId} do tenant ${tenantId}: ${erroRegistro.message}`);
      }
      try {
        const info = await metaWhatsappService.buscarInfoNumero(phoneNumberId);
        numeroExibido = info.display_phone_number || null;
      } catch {
        // segue sem o número formatado — status.conectado ainda funciona
      }
    } catch (erro) {
      return reply.code(400).send({ error: `Não foi possível conectar o WhatsApp: ${erro.message}` });
    }

    try {
      await pool.query('delete from crm_whatsapp_numeros where tenant_id = $1 and phone_number_id != $2', [tenantId, phoneNumberId]);
      await pool.query(
        `insert into crm_whatsapp_numeros (phone_number_id, tenant_id, meta_waba_id, numero_exibido)
         values ($1, $2, $3, $4)
         on conflict (phone_number_id) do update set tenant_id = excluded.tenant_id, meta_waba_id = excluded.meta_waba_id,
           numero_exibido = coalesce(excluded.numero_exibido, crm_whatsapp_numeros.numero_exibido)`,
        [phoneNumberId, tenantId, wabaId, numeroExibido]
      );
    } catch (erro) {
      if (erro.code === '23505') {
        return reply.code(409).send({ error: 'Esse número de WhatsApp já está conectado a outra conta Kyvvo.' });
      }
      throw erro;
    }

    // Onboarding dos modelos padrão (catálogo do admin) — best-effort, não
    // atrasa nem quebra a resposta da conexão (ver lib/provisionamento-whatsapp).
    provisionarWhatsapp(pool, { tenantId, wabaId }).catch((erro) => {
      request.log.error(`[whatsapp] falha ao provisionar modelos padrão pro tenant ${tenantId}: ${erro.message}`);
    });

    return { conectado: true, phoneNumberId, wabaId };
  });

  // --- Auth ----------------------------------------------------------------
  fastify.post('/crm/api/login', async (request, reply) => {
    const { email, senha } = request.body || {};
    if (!email || !senha) {
      return reply.code(400).send({ error: 'E-mail e senha são obrigatórios' });
    }

    let loginRes;
    try {
      loginRes = await fetch(`${PLATFORM_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, senha, produto: 'crm' }),
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      request.log.error(`Falha ao contatar o serviço de identidade (kyvvo-platform): ${err.message}`);
      return reply.code(502).send({ error: 'Não foi possível validar o login agora. Tente novamente em instantes.' });
    }
    if (!loginRes.ok) {
      const dados = await loginRes.json().catch(() => ({}));
      return reply.code(401).send({ error: dados.error || 'E-mail ou senha inválidos' });
    }
    const { token, nome, email_verified: emailVerificado } = await loginRes.json();

    // E-mail não verificado é a causa mais comum do 403 de `/crm/acesso`
    // logo abaixo (o `authenticate` do platform bloqueia qualquer rota não
    // whitelisted até confirmar) — checa aqui primeiro, direto da resposta
    // do login, pra mostrar o motivo real em vez do genérico "não tem
    // acesso ao módulo". O platform já disparou um novo link de confirmação
    // nesse mesmo login (fire-and-forget, com cooldown) — ver POST
    // /api/auth/login em kyvvo-platform/routes/auth.js.
    if (emailVerificado === false) {
      return reply.code(403).send({
        error: 'Seu e-mail não foi verificado. Enviamos uma nova confirmação para o e-mail cadastrado — clique no link para confirmar.',
      });
    }

    let acessoRes;
    try {
      acessoRes = await fetch(`${PLATFORM_URL}/api/auth/crm/acesso`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      request.log.error(`Falha ao checar acesso ao módulo crm: ${err.message}`);
      return reply.code(502).send({ error: 'Não foi possível validar o login agora. Tente novamente em instantes.' });
    }
    if (!acessoRes.ok) {
      return reply.code(403).send({ error: 'Sua conta Kyvvo não tem acesso ao módulo CRM.' });
    }
    const { tenantId } = await acessoRes.json();

    await inicializarEtapasPadrao(pool, tenantId);
    await inicializarModelosPadrao(pool, tenantId);
    const onboardingPendente = await tenantPrecisaOnboarding(pool, tenantId);

    // Best-effort: nunca impede o login se o kyvvo-platform estiver
    // instável nesse instante — "trocar de produto" é só um atalho de UX.
    let outrosProdutos = [];
    try {
      const entRes = await fetch(`${PLATFORM_URL}/entitlements/${tenantId}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      });
      if (entRes.ok) {
        const { modulos } = await entRes.json();
        outrosProdutos = (modulos || []).map((m) => PRODUTOS_CRUZADOS_CRM[m]).filter(Boolean);
      }
    } catch (err) {
      request.log.warn(`Falha ao buscar outros produtos do tenant: ${err.message}`);
    }

    return { token, nome, outros_produtos: outrosProdutos, onboarding_pendente: onboardingPendente };
  });

  // "Trocar de produto" (menu de perfil) — gera um código de handoff de
  // curta duração no kyvvo-platform, que o outro produto troca por uma
  // sessão já autenticada (ver GET /crm/sso abaixo e o par simétrico em
  // kyvvo-studio/kyvvo-people).
  fastify.post('/crm/api/meus-produtos/handoff', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { produto: produtoDestino, nome: nomeBody, outrosProdutos: outrosProdutosBody } = request.body || {};
    const destino = PRODUTOS_HANDOFF_DESTINO[produtoDestino];
    if (!destino) {
      return reply.code(400).send({ error: 'Produto inválido' });
    }
    const { tenantId, userId, email } = request.user;
    // nome e outrosProdutos do PONTO DE VISTA DO DESTINO (bug real em
    // produção, 2026-09-30) — o token RS256 do platform não carrega mais
    // esses campos (corte de sessão unificado), então o front manda o que
    // já tem cacheado em localStorage desde o login (ver public/shell.js) —
    // tira o destino da lista de outros produtos (ele não precisa linkar
    // pra si mesmo). Pode estar levemente desatualizado — aceitável, mesmo
    // trade-off já feito pro resto do "trocar de produto".
    const nome = nomeBody || '';
    const outrosProdutos = (outrosProdutosBody || []).filter((p) => p.chave !== produtoDestino);
    try {
      const res = await fetch(`${PLATFORM_URL}/internal/handoff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Token': process.env.INTERNAL_HANDOFF_TOKEN },
        body: JSON.stringify({ tenantId, userId, email, nome, outrosProdutos }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`platform respondeu ${res.status}`);
      const { code } = await res.json();
      return { url: `${destino}?code=${encodeURIComponent(code)}` };
    } catch (err) {
      request.log.error(`Falha ao gerar handoff: ${err.message}`);
      return reply.code(502).send({ error: 'Não foi possível gerar o login automático agora.' });
    }
  });

  // Consome um código de handoff vindo de outro produto (Studio/People) —
  // CA "clicar no produto já deve entrar logado". Sem preHandler de auth: é
  // exatamente o ponto de entrada de quem ainda não tem sessão no CRM. O CRM
  // nunca vê/toca usuarios/tenants (mesmo princípio do login normal acima) —
  // confia direto no que o platform devolveu, sem checagem local extra.
  // outrosProdutos vem do próprio payload do handoff (quem gerou o código já
  // manda a lista pronta, do ponto de vista do CRM — ver POST acima e o par
  // em kyvvo-studio/kyvvo-people). Fallback [] só pra payload antigo/de outra
  // origem que não mande esse campo.
  fastify.get('/crm/sso', async (request, reply) => {
    const { code } = request.query || {};
    if (!code) return reply.redirect('/crm/login.html');

    try {
      const res = await fetch(`${PLATFORM_URL}/internal/handoff/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Token': process.env.INTERNAL_HANDOFF_TOKEN },
        body: JSON.stringify({ code, emitirToken: true }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return reply.redirect('/crm/login.html');
      const { nome, outrosProdutos, token } = await res.json();

      reply.type('text/html');
      return `<!doctype html><html><body><script>
        localStorage.setItem('crm_token', ${JSON.stringify(token)});
        localStorage.setItem('crm_nome', ${JSON.stringify(nome || '')});
        localStorage.setItem('crm_outros_produtos', ${JSON.stringify(JSON.stringify(outrosProdutos || []))});
        location.href = '/crm/painel.html';
      </script></body></html>`;
    } catch (err) {
      request.log.error(`Falha ao consumir handoff: ${err.message}`);
      return reply.redirect('/crm/login.html');
    }
  });

  // Cadastro self-service (mesmo padrão do kyvvo-people): repassa pro
  // kyvvo-platform com produto:'crm'. Sem tela pública ainda (seção 7 do
  // doc não pede uma — Fase 1 é onboarding manual da Basic pelo Bruno) —
  // existe só pra permitir criar contas de teste via API.
  fastify.post('/crm/api/register', async (request, reply) => {
    let platformRes;
    try {
      platformRes = await fetch(`${PLATFORM_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...request.body, produto: 'crm' }),
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      request.log.error(`Falha ao registrar no kyvvo-platform: ${err.message}`);
      return reply.code(502).send({ error: 'Não foi possível criar sua conta agora. Tente novamente em instantes.' });
    }
    const dados = await platformRes.json().catch(() => ({}));
    if (!platformRes.ok) return reply.code(platformRes.status).send(dados);

    let tenantId;
    try {
      tenantId = JSON.parse(Buffer.from(dados.token.split('.')[1], 'base64url').toString('utf8')).tenantId;
    } catch (err) {
      request.log.error(`Conta criada no platform mas não consegui ler o tenantId do token: ${err.message}`);
      return reply.code(502).send({ error: 'Conta criada, mas não foi possível iniciar sua sessão. Faça login manualmente.' });
    }

    await inicializarEtapasPadrao(pool, tenantId);
    await inicializarModelosPadrao(pool, tenantId);
    const onboardingPendente = await tenantPrecisaOnboarding(pool, tenantId);
    return reply.code(201).send({ token: dados.token, nome: dados.nome, outros_produtos: [], onboarding_pendente: onboardingPendente });
  });

  // --- Plano e cobrança --------------------------------------------------------
  // O CRM não guarda o token RS256 do platform além do login (ver handoff
  // acima) — essas rotas são um proxy servidor-a-servidor pro
  // kyvvo-platform (routes/pagamentos-crm.js), autenticado por segredo
  // compartilhado (X-Internal-Token), mesmo padrão de lib/email.js. O CRM
  // já provou a identidade do usuário com a própria sessão (fastify.authenticate,
  // local); só repassa o tenantId.
  async function chamarPlatformInterno(path, { method = 'GET', body, reply } = {}) {
    let res;
    try {
      res = await fetch(`${PLATFORM_URL}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Internal-Token': process.env.PLATFORM_PAGAMENTOS_TOKEN },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      reply.log.error(`Falha ao chamar o platform em ${path}: ${err.message}`);
      reply.code(502).send({ error: 'Não foi possível falar com o serviço de cobrança agora. Tente novamente em instantes.' });
      return null;
    }
    const dados = await res.json().catch(() => ({}));
    if (!res.ok) {
      reply.code(res.status).send(dados);
      return null;
    }
    return dados;
  }

  fastify.get('/crm/api/pagamentos', { preHandler: fastify.authenticate }, async (request, reply) => {
    const dados = await chamarPlatformInterno(`/internal/pagamentos-crm/${request.user.tenantId}`, { reply });
    if (dados) return dados;
  });

  fastify.get('/crm/api/pagamentos/planos', { preHandler: fastify.authenticate }, async (request, reply) => {
    const dados = await chamarPlatformInterno('/internal/planos-crm', { reply });
    if (dados) return dados;
  });

  fastify.post('/crm/api/pagamentos/cadastrar', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId, email } = request.user;
    // `nome` não vem mais no token RS256 (corte de sessão unificado) — o
    // front manda, cacheado em localStorage desde o login (ver public/
    // plano-cobranca.html).
    const dados = await chamarPlatformInterno(`/internal/pagamentos-crm/${tenantId}/cadastrar`, {
      method: 'POST', body: { ...request.body, email }, reply,
    });
    if (dados) return dados;
  });

  fastify.patch('/crm/api/pagamentos/plano', { preHandler: fastify.authenticate }, async (request, reply) => {
    const dados = await chamarPlatformInterno(`/internal/pagamentos-crm/${request.user.tenantId}/plano`, { method: 'PATCH', body: request.body, reply });
    if (dados) return dados;
  });

  fastify.delete('/crm/api/pagamentos/assinatura', { preHandler: fastify.authenticate }, async (request, reply) => {
    const dados = await chamarPlatformInterno(`/internal/pagamentos-crm/${request.user.tenantId}/assinatura`, { method: 'DELETE', reply });
    if (dados) return dados;
  });

  // --- Clientes --------------------------------------------------------------
  // Paginação é opt-in (só ativa com `pagina` na query) — quadro.html e
  // campanhas.html chamam esta mesma rota esperando um array simples (picker
  // de cliente), sem página nem total; mudar a forma da resposta pra eles
  // quebraria os dois. A tela de Clientes (padrão de listagem do DS, Fase
  // 2 da padronização) é quem manda `pagina`/`tamanho` e recebe o formato novo.
  fastify.get('/crm/api/clientes', { preHandler: fastify.authenticate }, async (request) => {
    const { tenantId } = request.user;
    const busca = (request.query.busca || '').trim();
    const params = [tenantId];
    let filtro = '';
    if (busca) {
      params.push(`%${busca.toLowerCase()}%`);
      filtro = `and (lower(nome) like $2 or telefone like $2 or cpf like $2)`;
    }

    const pagina = Number.parseInt(request.query.pagina, 10);
    if (!pagina || pagina < 1) {
      const { rows } = await pool.query(
        `select id, nome, telefone, email, cidade, uf, origem, segmento, bloqueado, criado_em, data_nascimento
         from crm_clientes where tenant_id = $1 ${filtro}
         order by nome limit 200`,
        params
      );
      return rows;
    }

    const tamanho = Math.min(Math.max(Number.parseInt(request.query.tamanho, 10) || 25, 1), 100);
    params.push(tamanho, (pagina - 1) * tamanho);
    const { rows } = await pool.query(
      `select id, nome, telefone, email, cidade, uf, origem, segmento, bloqueado, criado_em, data_nascimento,
              count(*) over()::int as total_geral
       from crm_clientes where tenant_id = $1 ${filtro}
       order by nome limit $${params.length - 1} offset $${params.length}`,
      params
    );
    const total = rows[0] ? rows[0].total_geral : 0;
    return { dados: rows.map(({ total_geral, ...resto }) => resto), total };
  });

  fastify.post('/crm/api/clientes', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const { nome, telefone, email, cpf, cidade, uf, cep, data_nascimento, origem, segmento, observacoes } = request.body || {};
    if (!nome) return reply.code(400).send({ error: 'Nome é obrigatório' });

    const { rows } = await pool.query(
      `insert into crm_clientes (tenant_id, nome, telefone, email, cpf, cidade, uf, cep, data_nascimento, origem, segmento, observacoes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning *`,
      [tenantId, nome, paraE164(telefone), email || null, cpf || null, cidade || null, uf || null, cep || null, data_nascimento || null, origem || null, segmento || null, observacoes || null]
    );
    await pool.query(
      `insert into crm_eventos (tenant_id, cliente_id, tipo) values ($1, $2, 'criacao')`,
      [tenantId, rows[0].id]
    );
    return reply.code(201).send(rows[0]);
  });

  fastify.get('/crm/api/clientes/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const { rows } = await pool.query('select * from crm_clientes where id = $1 and tenant_id = $2', [request.params.id, tenantId]);
    if (!rows[0]) return reply.code(404).send({ error: 'Cliente não encontrado' });

    const [tags, pedidos, eventos, metricas] = await Promise.all([
      pool.query(
        `select t.id, t.nome from crm_tags t
         join crm_clientes_tags ct on ct.tag_id = t.id where ct.cliente_id = $1`,
        [rows[0].id]
      ),
      pool.query(
        `select p.*, e.nome as etapa_nome,
                coalesce((
                  select json_agg(json_build_object('id', a.id, 'nome_arquivo', a.nome_arquivo, 'tipo_mime', a.tipo_mime) order by a.criado_em)
                  from crm_pedidos_arquivos a where a.pedido_id = p.id
                ), '[]') as arquivos,
                coalesce((
                  select json_agg(json_build_object('descricao', coalesce(pr.nome, i.descricao), 'quantidade', i.quantidade))
                  from crm_pedidos_itens i left join crm_produtos pr on pr.id = i.produto_id where i.pedido_id = p.id
                ), '[]') as itens
         from crm_pedidos p
         join crm_etapas e on e.id = p.etapa_id
         where p.cliente_id = $1 order by p.numero desc`,
        [rows[0].id]
      ),
      pool.query('select * from crm_eventos where cliente_id = $1 order by criado_em desc limit 100', [rows[0].id]),
      buscarMetricas(pool, rows[0].id),
    ]);

    return {
      ...rows[0],
      tags: tags.rows,
      pedidos: pedidos.rows,
      eventos: eventos.rows,
      metricas,
    };
  });

  fastify.patch('/crm/api/clientes/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const campos = ['nome', 'telefone', 'email', 'cpf', 'cnpj', 'cidade', 'uf', 'cep', 'numero', 'complemento', 'endereco_completo', 'data_nascimento', 'origem', 'segmento', 'observacoes', 'bloqueado'];
    const body = request.body || {};
    const sets = [];
    const params = [request.params.id, tenantId];
    for (const campo of campos) {
      if (body[campo] === undefined) continue;
      params.push(campo === 'telefone' ? paraE164(body[campo]) : body[campo]);
      sets.push(`${campo} = $${params.length}`);
    }
    if (sets.length === 0) return reply.code(400).send({ error: 'Nenhum campo pra atualizar' });

    const { rows } = await pool.query(
      `update crm_clientes set ${sets.join(', ')}, atualizado_em = now() where id = $1 and tenant_id = $2 returning *`,
      params
    );
    if (!rows[0]) return reply.code(404).send({ error: 'Cliente não encontrado' });
    return rows[0];
  });

  // --- Opções de cadastro (Segmento/Origem do cliente e Tipo de frete do
  // pedido viram combobox) — CRUD gerenciado em Configurações > Cadastro.
  // `tipo` é 'segmento', 'origem' ou 'tipo_entrega' (mesma tabela pros três,
  // ver db/011_opcoes_cadastro.sql e db/018_opcoes_cadastro_tipo_entrega.sql).
  const TIPOS_OPCAO_CADASTRO = ['segmento', 'origem', 'tipo_entrega'];
  fastify.get('/crm/api/opcoes-cadastro', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tipo } = request.query || {};
    if (!TIPOS_OPCAO_CADASTRO.includes(tipo)) return reply.code(400).send({ error: `tipo inválido. Válidos: ${TIPOS_OPCAO_CADASTRO.join(', ')}` });
    const { rows } = await pool.query(
      'select * from crm_opcoes_cadastro where tenant_id = $1 and tipo = $2 order by valor',
      [request.user.tenantId, tipo]
    );
    return rows;
  });

  fastify.post('/crm/api/opcoes-cadastro', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const { tipo, valor, serie } = request.body || {};
    if (!TIPOS_OPCAO_CADASTRO.includes(tipo)) return reply.code(400).send({ error: `tipo inválido. Válidos: ${TIPOS_OPCAO_CADASTRO.join(', ')}` });
    if (!valor || !valor.trim()) return reply.code(400).send({ error: 'Valor é obrigatório' });
    const { rows } = await pool.query(
      `insert into crm_opcoes_cadastro (tenant_id, tipo, valor, serie) values ($1, $2, $3, $4)
       on conflict (tenant_id, tipo, lower(valor)) do update set ativo = true, serie = $4
       returning *`,
      [tenantId, tipo, valor.trim(), serie ? serie.trim() : null]
    );
    return reply.code(201).send(rows[0]);
  });

  fastify.patch('/crm/api/opcoes-cadastro/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    // Opção "sistema" (ex.: origem "WhatsApp", gravada pelo bot em todo
    // cliente/pedido que vem por lá) não pode ser editada nem desativada
    // pelo usuário — senão o bot continuaria gravando um valor que sumiu
    // da lista, quebrando o combobox de Origem silenciosamente.
    const { rows: atual } = await pool.query(
      'select sistema from crm_opcoes_cadastro where id = $1 and tenant_id = $2',
      [request.params.id, tenantId]
    );
    if (!atual[0]) return reply.code(404).send({ error: 'Opção não encontrada' });
    if (atual[0].sistema) return reply.code(400).send({ error: 'Esta opção é usada pelo bot e não pode ser alterada.' });

    const campos = ['valor', 'ativo', 'serie'];
    const body = request.body || {};
    const sets = [];
    const params = [request.params.id, tenantId];
    for (const campo of campos) {
      if (body[campo] === undefined) continue;
      params.push(campo === 'serie' ? (body[campo] ? String(body[campo]).trim() || null : null) : body[campo]);
      sets.push(`${campo} = $${params.length}`);
    }
    if (sets.length === 0) return reply.code(400).send({ error: 'Nenhum campo pra atualizar' });
    const { rows } = await pool.query(
      `update crm_opcoes_cadastro set ${sets.join(', ')} where id = $1 and tenant_id = $2 returning *`,
      params
    );
    if (!rows[0]) return reply.code(404).send({ error: 'Opção não encontrada' });
    return rows[0];
  });

  fastify.delete('/crm/api/opcoes-cadastro/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const { rows: atual } = await pool.query(
      'select sistema from crm_opcoes_cadastro where id = $1 and tenant_id = $2',
      [request.params.id, tenantId]
    );
    if (!atual[0]) return reply.code(404).send({ error: 'Opção não encontrada' });
    if (atual[0].sistema) return reply.code(400).send({ error: 'Esta opção é usada pelo bot e não pode ser removida.' });
    await pool.query('delete from crm_opcoes_cadastro where id = $1 and tenant_id = $2', [request.params.id, tenantId]);
    return { ok: true };
  });

  // --- Tags (US15) -------------------------------------------------------------
  fastify.get('/crm/api/tags', { preHandler: fastify.authenticate }, async (request) => {
    const { rows } = await pool.query('select * from crm_tags where tenant_id = $1 order by nome', [request.user.tenantId]);
    return rows;
  });

  fastify.delete('/crm/api/tags/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { rowCount } = await pool.query('delete from crm_tags where id = $1 and tenant_id = $2', [request.params.id, request.user.tenantId]);
    if (!rowCount) return reply.code(404).send({ error: 'Tag não encontrada' });
    return { ok: true };
  });

  // Acha-ou-cria a tag pelo nome (dedupe por tenant_id+nome) e associa ao
  // cliente — evita duas telas separadas (cadastrar tag / aplicar tag).
  fastify.post('/crm/api/clientes/:id/tags', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const nome = (request.body?.nome || '').trim();
    if (!nome) return reply.code(400).send({ error: 'Nome da tag é obrigatório' });

    const { rows: clienteRows } = await pool.query('select 1 from crm_clientes where id = $1 and tenant_id = $2', [request.params.id, tenantId]);
    if (!clienteRows[0]) return reply.code(404).send({ error: 'Cliente não encontrado' });

    const { rows: tagRows } = await pool.query(
      `insert into crm_tags (tenant_id, nome) values ($1, $2)
       on conflict (tenant_id, nome) do update set nome = excluded.nome returning *`,
      [tenantId, nome]
    );
    await pool.query(
      'insert into crm_clientes_tags (cliente_id, tag_id) values ($1, $2) on conflict do nothing',
      [request.params.id, tagRows[0].id]
    );
    return reply.code(201).send(tagRows[0]);
  });

  fastify.delete('/crm/api/clientes/:id/tags/:tagId', { preHandler: fastify.authenticate }, async (request, reply) => {
    await pool.query(
      `delete from crm_clientes_tags where cliente_id = $1 and tag_id = $2
       and cliente_id in (select id from crm_clientes where tenant_id = $3)`,
      [request.params.id, request.params.tagId, request.user.tenantId]
    );
    return { ok: true };
  });

  // --- Mesclagem de duplicados (US17) -------------------------------------
  fastify.get('/crm/api/clientes/duplicados', { preHandler: fastify.authenticate }, async (request) => {
    return buscarSugestoesDuplicados(pool, request.user.tenantId);
  });

  fastify.post('/crm/api/clientes/mesclar', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { manter_id, descartar_id } = request.body || {};
    if (!manter_id || !descartar_id) return reply.code(400).send({ error: 'manter_id e descartar_id são obrigatórios' });
    if (manter_id === descartar_id) return reply.code(400).send({ error: 'Escolha duas fichas diferentes' });
    const resultado = await mesclarClientes(pool, request.user.tenantId, manter_id, descartar_id);
    if (!resultado) return reply.code(404).send({ error: 'Cliente não encontrado' });
    return resultado;
  });

  // --- Importações (US21) -------------------------------------------------
  fastify.get('/crm/api/importacoes', { preHandler: fastify.authenticate }, async (request) => {
    const { rows } = await pool.query('select * from crm_importacoes where tenant_id = $1 order by criado_em desc limit 50', [request.user.tenantId]);
    return rows;
  });

  fastify.post('/crm/api/importacoes/csv', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    let arquivoBuffer = null, nomeArquivo = null, mapeamento = null;
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        arquivoBuffer = await part.toBuffer();
        nomeArquivo = part.filename;
      } else if (part.fieldname === 'mapeamento') {
        try { mapeamento = JSON.parse(part.value || '{}'); } catch { mapeamento = null; }
      }
    }
    if (!arquivoBuffer) return reply.code(400).send({ error: 'Arquivo é obrigatório' });
    if (!mapeamento || !mapeamento.nome) return reply.code(400).send({ error: 'Mapeamento precisa incluir pelo menos o campo "nome"' });

    const todasLinhas = parseCsv(arquivoBuffer.toString('utf8'));
    if (todasLinhas.length < 2) return reply.code(400).send({ error: 'CSV vazio ou sem linhas de dados' });
    const [cabecalho, ...linhas] = todasLinhas;

    const resultado = await importarClientesCsv(pool, tenantId, { cabecalho, linhas, mapeamento, nomeArquivo: nomeArquivo || 'arquivo.csv' });
    return reply.code(201).send(resultado);
  });

  // Processa em segundo plano (lib/importacoes.js#processarImportacaoNfeEmSegundoPlano)
  // — responde 202 assim que os arquivos chegam, sem esperar o lote inteiro
  // terminar. A tela faz polling em GET /crm/api/importacoes/:id (abaixo)
  // pra mostrar progresso real ("7 de 14") e ganha a notificação de
  // conclusão (sucesso/erro) no sininho quando terminar — achado real:
  // antes disso, um lote grande deixava a tela presa em "Importando…" sem
  // feedback nenhum até o fetch() do navegador completar.
  fastify.post('/crm/api/importacoes/nfe', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const arquivos = [];
    for await (const part of request.parts()) {
      if (part.type === 'file') arquivos.push({ nome: part.filename, buffer: await part.toBuffer() });
    }
    if (!arquivos.length) return reply.code(400).send({ error: 'Envie ao menos um arquivo XML' });

    const { rows } = await pool.query(
      `insert into crm_importacoes (tenant_id, tipo, arquivo, status, total_arquivos)
       values ($1, 'nfe_xml', $2, 'processando', $3) returning *`,
      [tenantId, arquivos.length === 1 ? arquivos[0].nome : `${arquivos.length} arquivos`, arquivos.length]
    );
    const importacao = rows[0];

    processarImportacaoNfeEmSegundoPlano(pool, tenantId, importacao.id, arquivos).catch((erro) => {
      fastify.log.error(`[importacao nfe ${importacao.id}] falha inesperada: ${erro.message}`);
    });

    return reply.code(202).send(importacao);
  });

  // Polling de progresso (ver rota acima) — tenant_id no WHERE evita um
  // tenant consultar o id de importação de outro só adivinhando o uuid.
  fastify.get('/crm/api/importacoes/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { rows } = await pool.query('select * from crm_importacoes where id = $1 and tenant_id = $2', [request.params.id, request.user.tenantId]);
    if (!rows[0]) return reply.code(404).send({ error: 'Importação não encontrada' });
    return rows[0];
  });

  // --- Etapas (config do funil, editável direto no quadro — mesmo padrão do
  // kyvvo-people/quadro.html: renomear, criar, apagar, reordenar) -------------
  // --- Onboarding visível (US26) -------------------------------------------
  // A criação do funil padrão continua automática (inicializarEtapasPadrao,
  // já rodou no login/register) — isto só controla se a tela de revisão já
  // foi confirmada.
  fastify.get('/crm/api/onboarding/estado', { preHandler: fastify.authenticate }, async (request) => {
    const pendente = await tenantPrecisaOnboarding(pool, request.user.tenantId);
    return { pendente, modelo: 'Produção sob encomenda' };
  });

  fastify.post('/crm/api/onboarding/confirmar', { preHandler: fastify.authenticate }, async (request) => {
    await confirmarOnboarding(pool, request.user.tenantId);
    return { ok: true };
  });

  fastify.get('/crm/api/etapas', { preHandler: fastify.authenticate }, async (request) => {
    const { rows } = await pool.query('select * from crm_etapas where tenant_id = $1 order by ordem', [request.user.tenantId]);
    return rows;
  });

  // Nova etapa entra como a última "aberta" (antes da primeira 'ganha'/
  // 'perdida') — quem cria e recebe pedidos nunca deve ficar depois de
  // "Enviado/Entregue"/"Perdido" sem querer.
  fastify.post('/crm/api/etapas', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const nome = (request.body?.nome || '').trim();
    if (!nome) return reply.code(400).send({ error: 'Nome é obrigatório' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: etapas } = await client.query(
        'select id, tipo from crm_etapas where tenant_id = $1 order by ordem', [tenantId]
      );
      const indice = etapas.findIndex((e) => e.tipo !== 'aberta');
      const posicao = indice === -1 ? etapas.length : indice;
      for (let i = etapas.length - 1; i >= posicao; i--) {
        await client.query('update crm_etapas set ordem = $1 where id = $2', [i + 1, etapas[i].id]);
      }
      const { rows } = await client.query(
        `insert into crm_etapas (tenant_id, nome, ordem, tipo) values ($1, $2, $3, 'aberta') returning *`,
        [tenantId, nome, posicao]
      );
      await client.query('COMMIT');
      return reply.code(201).send(rows[0]);
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    } finally {
      client.release();
    }
  });

  // Aceita nome e/ou eh_pronto (US28) — pelo menos um dos dois. Marcar
  // eh_pronto=true desmarca qualquer outra etapa da conta primeiro (só uma
  // etapa "pronto" por vez).
  fastify.patch('/crm/api/etapas/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const { nome, eh_pronto: ehPronto } = request.body || {};
    if (nome !== undefined && !nome.trim()) return reply.code(400).send({ error: 'Nome é obrigatório' });
    if (nome === undefined && ehPronto === undefined) return reply.code(400).send({ error: 'Nada pra atualizar' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (ehPronto === true) {
        await client.query('update crm_etapas set eh_pronto = false where tenant_id = $1', [tenantId]);
      }
      const sets = [];
      const params = [request.params.id, tenantId];
      if (nome !== undefined) { params.push(nome.trim()); sets.push(`nome = $${params.length}`); }
      if (ehPronto !== undefined) { params.push(ehPronto); sets.push(`eh_pronto = $${params.length}`); }
      const { rows } = await client.query(
        `update crm_etapas set ${sets.join(', ')} where id = $1 and tenant_id = $2 returning *`,
        params
      );
      await client.query('COMMIT');
      if (!rows[0]) return reply.code(404).send({ error: 'Etapa não encontrada' });
      return rows[0];
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    } finally {
      client.release();
    }
  });

  // Nunca apaga em cascata: pedido é dado demais pra sumir junto de uma
  // etapa apagada sem querer (diferente do candidato do People, que "volta
  // pra Nova"). Quem apagar precisa mover os pedidos primeiro.
  fastify.delete('/crm/api/etapas/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const { rows: etapaAlvo } = await pool.query('select fixa from crm_etapas where id = $1 and tenant_id = $2', [request.params.id, tenantId]);
    if (etapaAlvo[0] && etapaAlvo[0].fixa) {
      return reply.code(400).send({ error: 'Esta é a etapa fixa de entrada ("A fazer") e não pode ser apagada.' });
    }
    const { rows: contagem } = await pool.query(
      'select count(*)::int as total from crm_pedidos where etapa_id = $1 and tenant_id = $2',
      [request.params.id, tenantId]
    );
    if (contagem[0].total > 0) {
      return reply.code(409).send({ error: `Mova ${contagem[0].total} pedido(s) desta etapa antes de apagá-la.` });
    }
    const { rowCount } = await pool.query('delete from crm_etapas where id = $1 and tenant_id = $2', [request.params.id, tenantId]);
    if (!rowCount) return reply.code(404).send({ error: 'Etapa não encontrada' });
    return { ok: true };
  });

  fastify.patch('/crm/api/etapas/reordenar', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const ids = request.body?.ids;
    if (!Array.isArray(ids) || !ids.length) return reply.code(400).send({ error: 'ids é obrigatório' });
    // Etapa fixa ("A fazer") sempre em 1º — o frontend já trava o drag dela,
    // isso aqui é defesa em profundidade contra uma reordenação vinda de
    // fora do Quadro (ou de um bug no drag).
    const { rows: fixaRows } = await pool.query('select id from crm_etapas where tenant_id = $1 and fixa = true limit 1', [tenantId]);
    if (fixaRows[0] && ids[0] !== fixaRows[0].id) {
      return reply.code(400).send({ error: 'A etapa fixa ("A fazer") precisa continuar sendo a primeira.' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < ids.length; i++) {
        await client.query('update crm_etapas set ordem = $1 where id = $2 and tenant_id = $3', [i, ids[i], tenantId]);
      }
      await client.query('COMMIT');
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    } finally {
      client.release();
    }
    return { ok: true };
  });

  // --- Recursos de produção ("raias" do kanban — ex: impressoras 3D) ---------
  // Pedido sem recurso atribuído cai na raia fixa "Sem recurso" (recurso_id
  // null) no front. Configurável por conta — nada aqui é específico da
  // Basic (a impressora 3D é só o exemplo dela).
  fastify.get('/crm/api/recursos', { preHandler: fastify.authenticate }, async (request) => {
    const { rows } = await pool.query('select * from crm_recursos where tenant_id = $1 and ativo order by ordem', [request.user.tenantId]);
    return rows;
  });

  fastify.post('/crm/api/recursos', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const nome = (request.body?.nome || '').trim();
    if (!nome) return reply.code(400).send({ error: 'Nome é obrigatório' });
    const { rows: ordemRows } = await pool.query('select coalesce(max(ordem), -1) + 1 as prox from crm_recursos where tenant_id = $1', [tenantId]);
    const { rows } = await pool.query(
      `insert into crm_recursos (tenant_id, nome, ordem) values ($1, $2, $3) returning *`,
      [tenantId, nome, ordemRows[0].prox]
    );
    return reply.code(201).send(rows[0]);
  });

  fastify.patch('/crm/api/recursos/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    const nome = (request.body?.nome || '').trim();
    if (!nome) return reply.code(400).send({ error: 'Nome é obrigatório' });
    const { rows } = await pool.query(
      'update crm_recursos set nome = $1 where id = $2 and tenant_id = $3 returning *',
      [nome, request.params.id, request.user.tenantId]
    );
    if (!rows[0]) return reply.code(404).send({ error: 'Recurso não encontrado' });
    return rows[0];
  });

  // Apagar um recurso não mexe nos pedidos que estavam nele — o FK
  // (ON DELETE SET NULL) já joga eles de volta pra raia "Sem recurso".
  fastify.delete('/crm/api/recursos/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { rowCount } = await pool.query('delete from crm_recursos where id = $1 and tenant_id = $2', [request.params.id, request.user.tenantId]);
    if (!rowCount) return reply.code(404).send({ error: 'Recurso não encontrado' });
    return { ok: true };
  });

  // --- Pedidos / kanban --------------------------------------------------------
  // Filtros opcionais via querystring (etapa_id/recurso_id/status_pagamento/
  // prioridade/cliente_id) — usados pela tela de lista de Pedidos e pelo
  // atalho "Pedidos" no menu de ações de um cliente (o Quadro carrega tudo
  // de uma vez, sem filtro, pra desenhar o kanban inteiro).
  // Mesma regra de paginação opt-in de /crm/api/clientes e /crm/api/produtos:
  // quadro.html chama esta rota sem `pagina` (precisa do board inteiro de
  // uma vez) — só a tela de Pedidos (padrão de listagem do DS) manda
  // `pagina`/`tamanho` e recebe { dados, total }.
  fastify.get('/crm/api/pedidos', { preHandler: fastify.authenticate }, async (request) => {
    const { tenantId } = request.user;
    const {
      etapa_id, recurso_id, status_pagamento, prioridade, cliente_id, busca,
      tipo_entrega: tipoEntrega, data_inicio: dataInicio, data_fim: dataFim, ocultar_antigos_ultima_coluna: ocultarAntigos,
    } = request.query || {};
    const condicoes = ['p.tenant_id = $1'];
    const params = [tenantId];
    if (etapa_id) { params.push(etapa_id); condicoes.push(`p.etapa_id = $${params.length}`); }
    if (recurso_id) { params.push(recurso_id); condicoes.push(`p.recurso_id = $${params.length}`); }
    if (status_pagamento) { params.push(status_pagamento); condicoes.push(`p.status_pagamento = $${params.length}`); }
    if (prioridade) { params.push(prioridade); condicoes.push(`p.prioridade = $${params.length}`); }
    if (cliente_id) { params.push(cliente_id); condicoes.push(`p.cliente_id = $${params.length}`); }
    if (tipoEntrega) { params.push(tipoEntrega); condicoes.push(`p.tipo_entrega = $${params.length}`); }
    if (dataInicio) { params.push(dataInicio); condicoes.push(`p.criado_em >= $${params.length}::date`); }
    if (dataFim) { params.push(dataFim); condicoes.push(`p.criado_em < $${params.length}::date + interval '1 day'`); }
    if (busca) { params.push(`%${busca.trim().toLowerCase()}%`); condicoes.push(`lower(c.nome) like $${params.length}`); }
    // Usado só pelo Quadro (pedido do Bruno, 2026-10-03) — some da visão do
    // board um pedido parado há tempo demais na última coluna (maior
    // `ordem` de crm_etapas), configurável em Configurações > Geral. A lista
    // de Pedidos não manda esse parâmetro, então continua mostrando tudo.
    if (ocultarAntigos) {
      condicoes.push(`(
        p.etapa_id != (select id from crm_etapas where tenant_id = $1 order by ordem desc limit 1)
        or p.entrou_na_etapa_em >= now() - (
          (select coalesce(quadro_dias_ultima_coluna, 30) from crm_configuracoes where tenant_id = $1) || ' days'
        )::interval
      )`);
    }

    const camposBase = `p.*, c.nome as cliente_nome, c.telefone as cliente_telefone, r.nome as recurso_nome,
              extract(day from now() - p.entrou_na_etapa_em)::int as dias_na_etapa,
              coalesce((select sum(quantidade) from crm_pedidos_itens where pedido_id = p.id), 0) as quantidade_itens,
              coalesce((
                select json_agg(json_build_object('descricao', coalesce(pr.nome, i.descricao), 'quantidade', i.quantidade))
                from crm_pedidos_itens i left join crm_produtos pr on pr.id = i.produto_id where i.pedido_id = p.id
              ), '[]') as itens`;
    const dosJoins = `from crm_pedidos p
       join crm_clientes c on c.id = p.cliente_id
       left join crm_recursos r on r.id = p.recurso_id
       where ${condicoes.join(' and ')}`;

    const pagina = Number.parseInt(request.query.pagina, 10);
    if (!pagina || pagina < 1) {
      const { rows } = await pool.query(`select ${camposBase} ${dosJoins} order by p.criado_em desc`, params);
      return rows;
    }

    const tamanho = Math.min(Math.max(Number.parseInt(request.query.tamanho, 10) || 25, 1), 100);
    params.push(tamanho, (pagina - 1) * tamanho);
    const { rows } = await pool.query(
      `select ${camposBase}, count(*) over()::int as total_geral ${dosJoins}
       order by p.criado_em desc limit $${params.length - 1} offset $${params.length}`,
      params
    );
    const total = rows[0] ? rows[0].total_geral : 0;
    return { dados: rows.map(({ total_geral, ...resto }) => resto), total };
  });

  // Busca 1 pedido específico — usado pelo link direto `?abrir_pedido=<id>`
  // (Painel Hoje: clique na data de um orçamento parado/pagamento pendente).
  // Precisou existir à parte da listagem acima porque, com paginação real,
  // o pedido-alvo pode não estar na página carregada.
  fastify.get('/crm/api/pedidos/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { rows } = await pool.query(
      `select p.*, c.nome as cliente_nome, c.telefone as cliente_telefone, r.nome as recurso_nome,
              extract(day from now() - p.entrou_na_etapa_em)::int as dias_na_etapa,
              coalesce((select sum(quantidade) from crm_pedidos_itens where pedido_id = p.id), 0) as quantidade_itens,
              coalesce((
                select json_agg(json_build_object('descricao', coalesce(pr.nome, i.descricao), 'quantidade', i.quantidade))
                from crm_pedidos_itens i left join crm_produtos pr on pr.id = i.produto_id where i.pedido_id = p.id
              ), '[]') as itens
       from crm_pedidos p
       join crm_clientes c on c.id = p.cliente_id
       left join crm_recursos r on r.id = p.recurso_id
       where p.id = $1 and p.tenant_id = $2`,
      [request.params.id, request.user.tenantId]
    );
    if (!rows[0]) return reply.code(404).send({ error: 'Pedido não encontrado' });
    return rows[0];
  });

  // Criação rápida (seção 7.2): telefone (acha ou cria cliente), itens ou
  // descrição livre + quantidade, valor, origem, tipo de entrega, recurso
  // (raia) opcional. Resto é opcional.
  fastify.post('/crm/api/pedidos', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const { telefone, nome_cliente, itens, descricao, quantidade, produto_id, valor_total, origem, tipo_entrega, frete, data_entrega, recurso_id } = request.body || {};
    if (!origem) return reply.code(400).send({ error: 'Origem é obrigatória' });

    // "A fazer" (fixa=true, migration 013) é sempre onde todo pedido novo
    // entra — não mais "menor ordem entre tipo=aberta", que mudava se o
    // dono reordenasse as colunas do Quadro.
    const { rows: etapaRows } = await pool.query(
      `select id from crm_etapas where tenant_id = $1 and fixa = true limit 1`,
      [tenantId]
    );
    if (!etapaRows[0]) return reply.code(409).send({ error: 'Conta sem etapas configuradas' });

    const cliente = await encontrarOuCriarPorTelefone(pool, tenantId, { telefone, nome: nome_cliente, origem });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const numero = await proximoNumeroPedido(client, tenantId);
      const { rows: pedidoRows } = await client.query(
        `insert into crm_pedidos (tenant_id, cliente_id, etapa_id, origem, valor_total, tipo_entrega, frete, data_entrega, recurso_id, numero)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
        [tenantId, cliente.id, etapaRows[0].id, origem, valor_total || 0, tipo_entrega || null, frete || null, data_entrega || null, recurso_id || null, numero]
      );
      const pedido = pedidoRows[0];

      if (Array.isArray(itens) && itens.length > 0) {
        for (const item of itens) {
          await client.query(
            `insert into crm_pedidos_itens (pedido_id, produto_id, descricao, quantidade, valor_unitario)
             values ($1, $2, $3, $4, $5)`,
            [pedido.id, item.produto_id || null, item.descricao || null, item.quantidade || 1, item.valor_unitario || 0]
          );
        }
      } else if (descricao) {
        await client.query(
          `insert into crm_pedidos_itens (pedido_id, produto_id, descricao, quantidade, valor_unitario)
           values ($1, $2, $3, $4, $5)`,
          [pedido.id, produto_id || null, descricao, quantidade || 1, valor_total || 0]
        );
      }

      await client.query(
        `insert into crm_eventos (tenant_id, cliente_id, pedido_id, tipo) values ($1, $2, $3, 'criacao')`,
        [tenantId, cliente.id, pedido.id]
      );
      await client.query('COMMIT');
      dispararPedidoCriado(pool, { tenantId, pedidoId: pedido.id, cliente, valorTotal: pedido.valor_total })
        .catch((err) => fastify.log.error(`[automacoes] pedido_criado: ${err.message}`));
      // Configurações > Notificações ("Novo pedido criado") — diferente do
      // disparo acima (mensagem de WhatsApp pro CLIENTE, lib/automacoes.js):
      // esta é a notificação ADMIN (sino/e-mail/WhatsApp do dono do negócio).
      dispararNotificacaoEvento(pool, tenantId, 'pedido_criado', {
        titulo: `Novo pedido: ${cliente.nome || cliente.telefone}`,
        detalhe: `Pedido #${numero} — R$ ${Number(pedido.valor_total || 0).toFixed(2).replace('.', ',')}`,
      }).catch((err) => fastify.log.error(`[notificacoes] pedido_criado: ${err.message}`));
      return reply.code(201).send({ ...pedido, cliente });
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    } finally {
      client.release();
    }
  });

  // Best-effort, não bloqueia a resposta da rota que moveu o pedido — busca
  // nome/telefone do cliente (não vem no `returning *` de crm_pedidos) e
  // dispara toda automação 'mudanca_etapa' configurada pra etapa de destino.
  function disparaAutomacaoDeEtapa(pedido, etapa) {
    pool.query('select nome, telefone from crm_clientes where id = $1', [pedido.cliente_id])
      .then(({ rows }) => {
        if (!rows[0]) return null;
        return dispararMudancaEtapa(pool, {
          tenantId: pedido.tenant_id, pedidoId: pedido.id, etapaId: etapa.id, etapaNome: etapa.nome, cliente: rows[0],
        });
      })
      .catch((err) => fastify.log.error(`[automacoes] mudanca_etapa: ${err.message}`));
  }

  // Mover de etapa (arrastar no kanban). Exige motivo quando a etapa de
  // destino é do tipo 'perdida' (seção 7.2).
  fastify.patch('/crm/api/pedidos/:id/etapa', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId, userId } = request.user;
    const { etapa_id, motivo_perda } = request.body || {};
    if (!etapa_id) return reply.code(400).send({ error: 'etapa_id é obrigatório' });

    const { rows: etapaRows } = await pool.query('select * from crm_etapas where id = $1 and tenant_id = $2', [etapa_id, tenantId]);
    if (!etapaRows[0]) return reply.code(400).send({ error: 'Etapa inválida' });
    if (etapaRows[0].tipo === 'perdida' && !motivo_perda) {
      return reply.code(400).send({ error: 'Motivo é obrigatório ao mover pra Perdido' });
    }

    // Pedido do Bruno: só sai de "A fazer" (fixa=true) com cliente vinculado
    // de verdade — sem flag "cadastro real vs. automático" em crm_clientes,
    // usa nome preenchido e diferente do placeholder de
    // encontrarOuCriarPorTelefone (lib/clientes.js) como proxy.
    const { rows: pedidoAtual } = await pool.query(
      `select p.etapa_id, c.nome as cliente_nome from crm_pedidos p
       join crm_clientes c on c.id = p.cliente_id
       where p.id = $1 and p.tenant_id = $2`,
      [request.params.id, tenantId]
    );
    if (!pedidoAtual[0]) return reply.code(404).send({ error: 'Pedido não encontrado' });
    if (pedidoAtual[0].etapa_id !== etapa_id) {
      const { rows: etapaAtualRows } = await pool.query('select fixa from crm_etapas where id = $1', [pedidoAtual[0].etapa_id]);
      const clienteVinculado = pedidoAtual[0].cliente_nome && pedidoAtual[0].cliente_nome !== 'Sem nome';
      if (etapaAtualRows[0] && etapaAtualRows[0].fixa && !clienteVinculado) {
        return reply.code(400).send({ error: 'Vincule um cliente (com nome) antes de mover este pedido pra outra etapa.' });
      }
    }

    const { rows } = await pool.query(
      `update crm_pedidos set etapa_id = $1, entrou_na_etapa_em = now(), atualizado_em = now(),
              motivo_perda = case when $4::text is not null then $4 else motivo_perda end
       where id = $2 and tenant_id = $3 returning *`,
      [etapa_id, request.params.id, tenantId, motivo_perda || null]
    );
    if (!rows[0]) return reply.code(404).send({ error: 'Pedido não encontrado' });

    await pool.query(
      `insert into crm_eventos (tenant_id, cliente_id, pedido_id, tipo, dados, ator_id)
       values ($1, $2, $3, 'mudanca_etapa', $4, $5)`,
      [tenantId, rows[0].cliente_id, rows[0].id, JSON.stringify({ etapa_id, motivo_perda: motivo_perda || null }), userId || null]
    );
    disparaAutomacaoDeEtapa(rows[0], etapaRows[0]);
    // Configurações > Notificações ("Pedido pronto pra envio/retirada") —
    // só quando REALMENTE entrou numa etapa marcada eh_pronto (não repete se
    // já estava lá — pedidoAtual[0].etapa_id é a etapa de ANTES do UPDATE).
    if (etapaRows[0].eh_pronto && pedidoAtual[0].etapa_id !== etapa_id) {
      pool.query('select nome, telefone from crm_clientes where id = $1', [rows[0].cliente_id])
        .then(({ rows: clienteRows }) => {
          const cliente = clienteRows[0];
          return dispararNotificacaoEvento(pool, tenantId, 'pedido_pronto', {
            titulo: `Pedido pronto: ${(cliente && cliente.nome) || (cliente && cliente.telefone) || 'Sem nome'}`,
            detalhe: `Etapa "${etapaRows[0].nome}"`,
          });
        })
        .catch((err) => fastify.log.error(`[notificacoes] pedido_pronto: ${err.message}`));
    }
    return rows[0];
  });

  fastify.patch('/crm/api/pedidos/:id/pagamento', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const { status_pagamento, valor_recebido } = request.body || {};
    const { rows } = await pool.query(
      `update crm_pedidos set
         status_pagamento = coalesce($1, status_pagamento),
         valor_recebido = coalesce($2, valor_recebido),
         atualizado_em = now()
       where id = $3 and tenant_id = $4 returning *`,
      [status_pagamento || null, valor_recebido, request.params.id, tenantId]
    );
    if (!rows[0]) return reply.code(404).send({ error: 'Pedido não encontrado' });
    await pool.query(
      `insert into crm_eventos (tenant_id, cliente_id, pedido_id, tipo, dados) values ($1, $2, $3, 'pagamento', $4)`,
      [tenantId, rows[0].cliente_id, rows[0].id, JSON.stringify({ status_pagamento, valor_recebido })]
    );
    return rows[0];
  });

  // Dados de entrega/frete (data de entrega, tipo de frete, valor do frete,
  // observações) — mostrados no histórico de pedidos da ficha do cliente.
  // Sem evento próprio — não é mudança de etapa nem de pagamento, é só
  // informativo.
  fastify.patch('/crm/api/pedidos/:id/entrega', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const campos = ['data_entrega', 'data_emissao_nf', 'tipo_entrega', 'frete', 'frete_pago', 'observacoes', 'aviso_canal_proprio_fechado'];
    const body = request.body || {};
    const sets = [];
    const params = [request.params.id, tenantId];
    for (const campo of campos) {
      if (body[campo] === undefined) continue;
      // frete_pago é boolean not null — `false || null` virava null e
      // quebrava a constraint; os outros campos continuam podendo "limpar"
      // mandando string vazia.
      params.push(typeof body[campo] === 'boolean' ? body[campo] : (body[campo] || null));
      sets.push(`${campo} = $${params.length}`);
    }
    if (!sets.length) return reply.code(400).send({ error: 'Nenhum campo pra atualizar' });
    const { rows } = await pool.query(
      `update crm_pedidos set ${sets.join(', ')}, atualizado_em = now() where id = $1 and tenant_id = $2 returning *`,
      params
    );
    if (!rows[0]) return reply.code(404).send({ error: 'Pedido não encontrado' });
    return rows[0];
  });

  // "Vincular a um cliente" (menu ⋯ do Quadro) — troca o cliente_id do
  // pedido por um cliente JÁ EXISTENTE (busca em GET /crm/api/clientes),
  // pro caso de pedido criado automaticamente (bot/importação) com cliente
  // errado/sem nome e precisar apontar pro cadastro certo.
  fastify.patch('/crm/api/pedidos/:id/cliente', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const { cliente_id: clienteId } = request.body || {};
    if (!clienteId) return reply.code(400).send({ error: 'cliente_id é obrigatório' });

    const { rows: clienteRows } = await pool.query('select id from crm_clientes where id = $1 and tenant_id = $2', [clienteId, tenantId]);
    if (!clienteRows[0]) return reply.code(400).send({ error: 'Cliente inválido' });

    const { rows } = await pool.query(
      `update crm_pedidos set cliente_id = $1, atualizado_em = now() where id = $2 and tenant_id = $3 returning *`,
      [clienteId, request.params.id, tenantId]
    );
    if (!rows[0]) return reply.code(404).send({ error: 'Pedido não encontrado' });
    return rows[0];
  });

  // Atribuir/trocar/remover o recurso (raia) de um pedido — arrastar entre
  // raias no quadro, ou pelo select do modal de detalhe.
  fastify.patch('/crm/api/pedidos/:id/recurso', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const { recurso_id } = request.body || {};
    if (recurso_id) {
      const { rows: recursoRows } = await pool.query('select 1 from crm_recursos where id = $1 and tenant_id = $2', [recurso_id, tenantId]);
      if (!recursoRows[0]) return reply.code(400).send({ error: 'Recurso inválido' });
    }
    const { rows } = await pool.query(
      `update crm_pedidos set recurso_id = $1, atualizado_em = now() where id = $2 and tenant_id = $3 returning *`,
      [recurso_id || null, request.params.id, tenantId]
    );
    if (!rows[0]) return reply.code(404).send({ error: 'Pedido não encontrado' });
    return rows[0];
  });

  // Prioridade do pedido (combo Altíssima/Alta/Média/Baixa, pedido do
  // Bruno 2026-09-25) — "Altíssima" isola o pedido numa raia própria no
  // Quadro (ver telas em desenho, GitHub issue), fundo vermelho 40%.
  const PRIORIDADES_VALIDAS = ['altissima', 'alta', 'media', 'baixa'];
  fastify.patch('/crm/api/pedidos/:id/prioridade', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const { prioridade } = request.body || {};
    if (prioridade !== null && !PRIORIDADES_VALIDAS.includes(prioridade)) {
      return reply.code(400).send({ error: `Prioridade inválida. Válidas: ${PRIORIDADES_VALIDAS.join(', ')}, ou null pra limpar.` });
    }
    const { rows } = await pool.query(
      `update crm_pedidos set prioridade = $1, atualizado_em = now() where id = $2 and tenant_id = $3 returning *`,
      [prioridade || null, request.params.id, tenantId]
    );
    if (!rows[0]) return reply.code(404).send({ error: 'Pedido não encontrado' });
    return rows[0];
  });

  // Cancelamento de pedido — kebab menu da lista de Pedidos pede confirmação
  // no front antes de chamar isto (ver GitHub issue da tela de lista).
  // Reaproveita a etapa tipo 'perdida' já existente (mesmo conceito do
  // drag-and-drop no Quadro) em vez de um status novo — motivo obrigatório,
  // mesma regra de PATCH /pedidos/:id/etapa.
  fastify.post('/crm/api/pedidos/:id/cancelar', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId, userId } = request.user;
    const { motivo } = request.body || {};
    if (!motivo) return reply.code(400).send({ error: 'Motivo é obrigatório pra cancelar um pedido' });

    const { rows: etapaRows } = await pool.query(
      `select id, nome from crm_etapas where tenant_id = $1 and tipo = 'perdida' order by ordem asc limit 1`,
      [tenantId]
    );
    if (!etapaRows[0]) return reply.code(409).send({ error: 'Conta sem etapa do tipo "perdida" configurada' });

    const { rows } = await pool.query(
      `update crm_pedidos set etapa_id = $1, entrou_na_etapa_em = now(), atualizado_em = now(), motivo_perda = $4
       where id = $2 and tenant_id = $3 returning *`,
      [etapaRows[0].id, request.params.id, tenantId, motivo]
    );
    if (!rows[0]) return reply.code(404).send({ error: 'Pedido não encontrado' });

    await pool.query(
      `insert into crm_eventos (tenant_id, cliente_id, pedido_id, tipo, dados, ator_id)
       values ($1, $2, $3, 'mudanca_etapa', $4, $5)`,
      [tenantId, rows[0].cliente_id, rows[0].id, JSON.stringify({ etapa_id: etapaRows[0].id, motivo_perda: motivo, origem: 'cancelamento_lista' }), userId || null]
    );
    disparaAutomacaoDeEtapa(rows[0], etapaRows[0]);
    return rows[0];
  });

  // --- Relatórios (pedido do Bruno, 2026-10-02) -----------------------------
  // Mesmo filtro pra tela (JSON) e pra exportação em PDF — só muda o que faz
  // com o resultado. Ver lib/relatorios.js pro porquê de ser um motor único
  // parametrizado por `agrupar_por` em vez de 6 relatórios hardcoded.
  function filtrosRelatorioDaQuery(query) {
    return {
      dataInicio: query.data_inicio || null,
      dataFim: query.data_fim || null,
      tipoEntrega: query.tipo_entrega || null,
      segmento: query.segmento || null,
      origem: query.origem || null,
      agruparPor: query.agrupar_por || null,
      // Drill-down do card "Resumo" (Painel Hoje) — ver lib/relatorios.js.
      etapaId: query.etapa_id || null,
      apenasHoje: query.apenas_hoje === '1',
      proximosEntregaDias: query.proximos_entrega_dias ? Number(query.proximos_entrega_dias) : null,
    };
  }

  fastify.get('/crm/api/relatorios/pedidos', { preHandler: fastify.authenticate }, async (request) => {
    return relatorioPedidos(pool, request.user.tenantId, filtrosRelatorioDaQuery(request.query || {}));
  });

  // Listagem individual (não agrupada) — usada pelo drill-down do card
  // "Resumo" do Painel Hoje: cada métrica/etapa clicada abre essa lista
  // filtrada em vez do relatório agregado.
  fastify.get('/crm/api/relatorios/pedidos/lista', { preHandler: fastify.authenticate }, async (request) => {
    return listarPedidosDetalhado(pool, request.user.tenantId, filtrosRelatorioDaQuery(request.query || {}));
  });

  fastify.get('/crm/api/relatorios/pedidos/pdf', { preHandler: fastify.authenticate }, async (request, reply) => {
    const filtros = filtrosRelatorioDaQuery(request.query || {});
    const { resumo, detalhado, agrupar_por: agruparPor } = await relatorioPedidos(pool, request.user.tenantId, filtros);
    const titulosAgrupamento = {
      dia: 'Dia', cliente: 'Cliente', tipo_entrega: 'Tipo de frete', segmento: 'Segmento', origem: 'Origem',
    };

    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', 'attachment; filename="relatorio-pedidos.pdf"');

    const doc = novoDocumentoRelatorio('Relatório de Pedidos');
    desenharResumo(doc, [
      { rotulo: 'Pedidos', valor: String(resumo.quantidade) },
      { rotulo: 'Valor total', valor: formatarMoedaPdf(resumo.valor_total) },
      { rotulo: 'Ticket médio', valor: formatarMoedaPdf(resumo.ticket_medio) },
      { rotulo: 'Frete total', valor: formatarMoedaPdf(resumo.frete_total) },
    ]);
    if (agruparPor && detalhado.length) {
      // lineBreak:false — ver comentário em lib/pdf-relatorios.js sobre o
      // bug real de recursão infinita quando um texto pode quebrar linha
      // bem perto do fim da página.
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#0F111A').text(`Detalhado por ${titulosAgrupamento[agruparPor]}`, { lineBreak: false });
      doc.moveDown(0.5);
      desenharTabela(
        doc,
        [
          { chave: 'rotulo', titulo: titulosAgrupamento[agruparPor] },
          { chave: 'quantidade', titulo: 'Pedidos', align: 'right' },
          { chave: 'valor_total', titulo: 'Valor total', align: 'right' },
        ],
        detalhado.map((d) => ({ ...d, valor_total: formatarMoedaPdf(d.valor_total) }))
      );
    }
    doc.end();
    return reply.send(doc);
  });

  // Download de um arquivo anexado a um pedido (STL/foto enviada pelo
  // cliente via bot de WhatsApp, ver lib/whatsapp-media.js) — nunca público,
  // sempre autenticado; o join com tenant_id garante isolamento (nunca
  // confiar em ids vindos do client sem esse filtro).
  fastify.get('/crm/api/pedidos/:id/arquivos/:arquivoId', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const { rows } = await pool.query(
      `select a.nome_arquivo, a.caminho_arquivo, a.tipo_mime
       from crm_pedidos_arquivos a
       join crm_pedidos p on p.id = a.pedido_id
       where a.id = $1 and a.pedido_id = $2 and p.tenant_id = $3`,
      [request.params.arquivoId, request.params.id, tenantId]
    );
    if (!rows[0]) return reply.code(404).send({ error: 'Arquivo não encontrado' });
    const caminhoAbsoluto = path.join(DIR_UPLOADS, rows[0].caminho_arquivo);
    return reply
      .header('Content-Disposition', `attachment; filename="${rows[0].nome_arquivo}"`)
      .type(rows[0].tipo_mime || 'application/octet-stream')
      .send(fs.createReadStream(caminhoAbsoluto));
  });

  // --- Produtos (US18) -----------------------------------------------------------
  // Mesma regra de paginação opt-in de /crm/api/clientes: quadro.html,
  // pedidos.html e campanhas.html chamam esta rota sem `pagina` (picker de
  // produto, array simples) — só a tela de Estoque (padrão de listagem do
  // DS) manda `pagina`/`tamanho` e recebe { dados, total }.
  fastify.get('/crm/api/produtos', { preHandler: fastify.authenticate }, async (request) => {
    const { tenantId } = request.user;
    const busca = (request.query.busca || '').trim();
    const params = [tenantId];
    let filtro = '';
    if (busca) {
      params.push(`%${busca.toLowerCase()}%`);
      filtro = `and (lower(nome) like $2 or lower(identificador_externo) like $2 or lower(observacao) like $2)`;
    }

    const pagina = Number.parseInt(request.query.pagina, 10);
    if (!pagina || pagina < 1) {
      const { rows } = await pool.query(`select * from crm_produtos where tenant_id = $1 ${filtro} order by nome`, params);
      return rows;
    }

    const tamanho = Math.min(Math.max(Number.parseInt(request.query.tamanho, 10) || 25, 1), 100);
    params.push(tamanho, (pagina - 1) * tamanho);
    const { rows } = await pool.query(
      `select *, count(*) over()::int as total_geral from crm_produtos where tenant_id = $1 ${filtro}
       order by nome limit $${params.length - 1} offset $${params.length}`,
      params
    );
    const total = rows[0] ? rows[0].total_geral : 0;
    return { dados: rows.map(({ total_geral, ...resto }) => resto), total };
  });

  fastify.post('/crm/api/produtos', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const { nome, categoria, preco_referencia, identificador_externo, quantidade, observacao } = request.body || {};
    if (!nome || !nome.trim()) return reply.code(400).send({ error: 'Nome é obrigatório' });
    const { rows } = await pool.query(
      `insert into crm_produtos (tenant_id, nome, categoria, preco_referencia, identificador_externo, quantidade, observacao)
       values ($1, $2, $3, $4, $5, $6, $7) returning *`,
      [tenantId, nome.trim(), categoria || null, preco_referencia || null, identificador_externo || null, quantidade || 0, observacao || null]
    );
    return reply.code(201).send(rows[0]);
  });

  fastify.patch('/crm/api/produtos/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const campos = ['nome', 'categoria', 'preco_referencia', 'identificador_externo', 'quantidade', 'observacao', 'ativo'];
    const body = request.body || {};
    const sets = [];
    const params = [request.params.id, tenantId];
    for (const campo of campos) {
      if (body[campo] === undefined) continue;
      params.push(body[campo]);
      sets.push(`${campo} = $${params.length}`);
    }
    if (!sets.length) return reply.code(400).send({ error: 'Nenhum campo pra atualizar' });
    const { rows } = await pool.query(`update crm_produtos set ${sets.join(', ')} where id = $1 and tenant_id = $2 returning *`, params);
    if (!rows[0]) return reply.code(404).send({ error: 'Produto não encontrado' });
    return rows[0];
  });

  // Apagar um produto não afeta itens de pedido já lançados com ele — o FK
  // (ON DELETE SET NULL em crm_pedidos_itens.produto_id) só solta a
  // referência, a descrição/valor do item já lançado continuam intactos.
  fastify.delete('/crm/api/produtos/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { rowCount } = await pool.query('delete from crm_produtos where id = $1 and tenant_id = $2', [request.params.id, request.user.tenantId]);
    if (!rowCount) return reply.code(404).send({ error: 'Produto não encontrado' });
    return { ok: true };
  });

  // --- Modelos de mensagem (US25) -----------------------------------------------
  // Sem POST/DELETE livre: as 5 chaves mapeiam pra pontos fixos do código
  // (Painel Hoje), então só editar o texto (e, pra 'aniversario_email', o
  // assunto) faz sentido no MVP.
  fastify.get('/crm/api/modelos-mensagem', { preHandler: fastify.authenticate }, async (request) => {
    const { rows } = await pool.query('select * from crm_modelos_mensagem where tenant_id = $1 order by chave', [request.user.tenantId]);
    return rows;
  });

  fastify.patch('/crm/api/modelos-mensagem/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    const texto = (request.body?.texto || '').trim();
    if (!texto) return reply.code(400).send({ error: 'Texto é obrigatório' });
    const assunto = request.body?.assunto != null ? request.body.assunto.trim() : undefined;
    const { rows } = await pool.query(
      `update crm_modelos_mensagem set texto = $1, assunto = coalesce($2, assunto) where id = $3 and tenant_id = $4 returning *`,
      [texto, assunto, request.params.id, request.user.tenantId]
    );
    if (!rows[0]) return reply.code(404).send({ error: 'Modelo não encontrado' });
    return rows[0];
  });

  // Usado só pelo slug de Formulários agora (Campos customizados, que também
  // usava isto, foi removido — pedido do Bruno, 2026-09-25).
  function slugificar(texto) {
    return String(texto)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'campo';
  }

  // --- Formulário de captação (US22) ---------------------------------------------
  // Campos são só perguntas extras em texto livre (além de nome/telefone/
  // e-mail, que são fixos) — cobre "campos escolhidos pela conta" sem
  // precisar de um construtor de formulário genérico completo.
  fastify.get('/crm/api/formularios', { preHandler: fastify.authenticate }, async (request) => {
    const { rows } = await pool.query('select * from crm_formularios where tenant_id = $1 order by criado_em desc', [request.user.tenantId]);
    return rows;
  });

  fastify.post('/crm/api/formularios', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const { nome, campos, tag_id } = request.body || {};
    if (!nome || !nome.trim()) return reply.code(400).send({ error: 'Nome é obrigatório' });

    const base = slugificar(nome);
    let slug = base;
    let contador = 2;
    for (;;) {
      const { rows: existe } = await pool.query('select 1 from crm_formularios where tenant_id = $1 and slug = $2', [tenantId, slug]);
      if (!existe[0]) break;
      slug = `${base}_${contador++}`;
    }

    const { rows } = await pool.query(
      `insert into crm_formularios (tenant_id, nome, slug, campos, tag_id) values ($1, $2, $3, $4, $5) returning *`,
      [tenantId, nome.trim(), slug, JSON.stringify(Array.isArray(campos) ? campos : []), tag_id || null]
    );
    return reply.code(201).send(rows[0]);
  });

  fastify.patch('/crm/api/formularios/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { ativo } = request.body || {};
    if (ativo === undefined) return reply.code(400).send({ error: 'Nada pra atualizar' });
    const { rows } = await pool.query(
      'update crm_formularios set ativo = $1 where id = $2 and tenant_id = $3 returning *',
      [ativo, request.params.id, request.user.tenantId]
    );
    if (!rows[0]) return reply.code(404).send({ error: 'Formulário não encontrado' });
    return rows[0];
  });

  fastify.delete('/crm/api/formularios/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { rowCount } = await pool.query('delete from crm_formularios where id = $1 and tenant_id = $2', [request.params.id, request.user.tenantId]);
    if (!rowCount) return reply.code(404).send({ error: 'Formulário não encontrado' });
    return { ok: true };
  });

  // Rota PÚBLICA (sem preHandler de auth) — usa o id (UUID) como
  // identificador na URL em vez do slug, pra não precisar resolver o tenant
  // a partir de um slug que só é único DENTRO da conta.
  fastify.get('/crm/api/formularios/publico/:id', async (request, reply) => {
    const { rows } = await pool.query('select id, nome, campos from crm_formularios where id = $1 and ativo = true', [request.params.id]);
    if (!rows[0]) return reply.code(404).send({ error: 'Formulário não encontrado ou desativado.' });
    return rows[0];
  });

  fastify.post('/crm/api/formularios/publico/:id/responder', async (request, reply) => {
    const { rows: formRows } = await pool.query('select * from crm_formularios where id = $1 and ativo = true', [request.params.id]);
    if (!formRows[0]) return reply.code(404).send({ error: 'Formulário não encontrado ou desativado.' });
    const formulario = formRows[0];

    const { nome, telefone, email, aceite_comunicacao, extras } = request.body || {};
    if (!nome || !nome.trim()) return reply.code(400).send({ error: 'Nome é obrigatório' });
    if (!aceite_comunicacao) return reply.code(422).send({ error: 'É preciso aceitar receber comunicação pra enviar o formulário.' });

    const cliente = await encontrarOuCriarPorTelefone(pool, formulario.tenant_id, {
      telefone, nome, origem: `formulário: ${formulario.nome}`,
    });
    await pool.query(
      `update crm_clientes set email = coalesce(email, $1), consentimento_data = now(),
              consentimento_canal = 'formulario', consentimento_texto = $2
       where id = $3`,
      [email || null, `Aceite no formulário "${formulario.nome}"`, cliente.id]
    );
    if (formulario.tag_id) {
      await pool.query('insert into crm_clientes_tags (cliente_id, tag_id) values ($1, $2) on conflict do nothing', [cliente.id, formulario.tag_id]);
    }
    await pool.query(
      'insert into crm_formularios_respostas (formulario_id, cliente_id, respostas) values ($1, $2, $3)',
      [formulario.id, cliente.id, JSON.stringify({ nome, telefone, email, extras: extras || {} })]
    );
    await pool.query(
      `insert into crm_eventos (tenant_id, cliente_id, tipo, dados) values ($1, $2, 'formulario', $3)`,
      [formulario.tenant_id, cliente.id, JSON.stringify({ formulario: formulario.nome })]
    );

    return reply.code(201).send({ ok: true });
  });

  // --- Campanhas: público (segmento), disparo e sorteio (US23/US24 + disparo) ------
  // Uma campanha é uma linha de crm_segmentos (db/030_campanhas.sql): filtros do
  // público + tipo (disparo|sorteio) + canal + conteúdo/prêmio. A lógica de
  // envio e sorteio fica em lib/campanhas.js.
  fastify.post('/crm/api/segmentos/preview', { preHandler: fastify.authenticate }, async (request) => {
    const clientes = await resolverSegmento(pool, request.user.tenantId, request.body?.filtros);
    return { total: clientes.length, clientes };
  });

  // Canais disponíveis pro assistente: WhatsApp (número vinculado + modelos
  // aprovados na Meta) e e-mail (provedor configurado no servidor).
  fastify.get('/crm/api/campanhas/canais', { preHandler: fastify.authenticate }, async (request) => {
    const { rows } = await pool.query('select numero_exibido from crm_whatsapp_numeros where tenant_id = $1 limit 1', [request.user.tenantId]);
    const modelos = rows[0] ? await listarTemplates() : [];
    return {
      whatsapp: { conectado: !!rows[0], numero: rows[0] ? rows[0].numero_exibido : null, modelos: modelos.filter((m) => m.status === 'APPROVED') },
      email: { disponivel: !!(process.env.PLATFORM_EMAIL_TOKEN || process.env.RESEND_API_KEY) },
    };
  });

  fastify.get('/crm/api/segmentos', { preHandler: fastify.authenticate }, async (request) => {
    const { rows } = await pool.query(
      `select s.*,
              coalesce(e.enviados, 0) as enviados, coalesce(e.erros, 0) as erros, coalesce(e.ignorados, 0) as ignorados
       from crm_segmentos s
       left join lateral (
         select count(*) filter (where status = 'enviado')::int as enviados,
                count(*) filter (where status = 'erro')::int as erros,
                count(*) filter (where status = 'ignorado')::int as ignorados
         from crm_campanhas_envios where campanha_id = s.id and finalidade = 'disparo'
       ) e on true
       where s.tenant_id = $1 order by s.criado_em desc`,
      [request.user.tenantId]
    );
    return rows;
  });

  fastify.post('/crm/api/segmentos', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { erro, valores: v } = campanhas.normalizarCampanha(request.body);
    if (erro) return reply.code(400).send({ error: erro });
    const { rows } = await pool.query(
      `insert into crm_segmentos (tenant_id, nome, filtros, tipo, canal, whatsapp_template, assunto, corpo,
                                  premio_tipo, premio_descricao, premio_valor, qtd_vencedores, notificar_vencedores)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning *`,
      [request.user.tenantId, v.nome, JSON.stringify(v.filtros), v.tipo, v.canal, v.whatsapp_template, v.assunto, v.corpo,
        v.premio_tipo, v.premio_descricao, v.premio_valor, v.qtd_vencedores, v.notificar_vencedores]
    );
    return reply.code(201).send(rows[0]);
  });

  // Edita um rascunho (campanha já enviada/sorteada não muda: vira histórico).
  fastify.patch('/crm/api/segmentos/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const { rows: atuais } = await pool.query('select * from crm_segmentos where id = $1 and tenant_id = $2', [request.params.id, tenantId]);
    if (!atuais[0]) return reply.code(404).send({ error: 'Campanha não encontrada' });
    if (atuais[0].status === 'enviando' || atuais[0].status === 'enviada') {
      return reply.code(409).send({ error: 'Campanha já enviada não pode ser editada. Duplique-a para criar uma nova.' });
    }
    const { erro, valores: v } = campanhas.normalizarCampanha({ ...atuais[0], ...request.body });
    if (erro) return reply.code(400).send({ error: erro });
    const { rows } = await pool.query(
      `update crm_segmentos set nome = $3, filtros = $4, tipo = $5, canal = $6, whatsapp_template = $7, assunto = $8, corpo = $9,
              premio_tipo = $10, premio_descricao = $11, premio_valor = $12, qtd_vencedores = $13, notificar_vencedores = $14,
              atualizado_em = now()
       where id = $1 and tenant_id = $2 returning *`,
      [request.params.id, tenantId, v.nome, JSON.stringify(v.filtros), v.tipo, v.canal, v.whatsapp_template, v.assunto, v.corpo,
        v.premio_tipo, v.premio_descricao, v.premio_valor, v.qtd_vencedores, v.notificar_vencedores]
    );
    return rows[0];
  });

  fastify.post('/crm/api/segmentos/:id/duplicar', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { rows } = await pool.query(
      `insert into crm_segmentos (tenant_id, nome, filtros, tipo, canal, whatsapp_template, assunto, corpo,
                                  premio_tipo, premio_descricao, premio_valor, qtd_vencedores, notificar_vencedores)
       select tenant_id, nome || ' (cópia)', filtros, tipo, canal, whatsapp_template, assunto, corpo,
              premio_tipo, premio_descricao, premio_valor, qtd_vencedores, notificar_vencedores
       from crm_segmentos where id = $1 and tenant_id = $2 returning *`,
      [request.params.id, request.user.tenantId]
    );
    if (!rows[0]) return reply.code(404).send({ error: 'Campanha não encontrada' });
    return reply.code(201).send(rows[0]);
  });

  fastify.delete('/crm/api/segmentos/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { rowCount } = await pool.query('delete from crm_segmentos where id = $1 and tenant_id = $2', [request.params.id, request.user.tenantId]);
    if (!rowCount) return reply.code(404).send({ error: 'Segmento não encontrado' });
    return { ok: true };
  });

  fastify.get('/crm/api/segmentos/:id/clientes', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const { rows } = await pool.query('select * from crm_segmentos where id = $1 and tenant_id = $2', [request.params.id, tenantId]);
    if (!rows[0]) return reply.code(404).send({ error: 'Segmento não encontrado' });
    const clientes = await resolverSegmento(pool, tenantId, rows[0].filtros);
    return { segmento: rows[0], clientes };
  });

  // Dispara a campanha (WhatsApp ou e-mail). Responde 202 na hora e envia em
  // segundo plano — a tela acompanha pelo status ('enviando' → 'enviada').
  fastify.post('/crm/api/segmentos/:id/enviar', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const { rows } = await pool.query('select * from crm_segmentos where id = $1 and tenant_id = $2', [request.params.id, tenantId]);
    const campanha = rows[0];
    if (!campanha) return reply.code(404).send({ error: 'Campanha não encontrada' });

    const preparo = await campanhas.prepararDisparo(pool, { tenantId, campanha });
    if (preparo.erro) return reply.code(preparo.status || 400).send({ error: preparo.erro });

    // `where status <> 'enviando'/'enviada'` fecha a janela de dois cliques seguidos
    const { rows: marcada } = await pool.query(
      `update crm_segmentos set status = 'enviando', enviado_em = now(), total_publico = $3, atualizado_em = now()
       where id = $1 and tenant_id = $2 and status in ('rascunho', 'sorteada') returning *`,
      [campanha.id, tenantId, preparo.clientes.length]
    );
    if (!marcada[0]) return reply.code(409).send({ error: 'Esta campanha já foi enviada ou está sendo enviada.' });

    setImmediate(() => campanhas.executarDisparo(pool, { tenantId, campanha: marcada[0], clientes: preparo.clientes }));
    return reply.code(202).send({ ok: true, total: preparo.clientes.length });
  });

  fastify.get('/crm/api/segmentos/:id/envios', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const { rows: seg } = await pool.query('select id from crm_segmentos where id = $1 and tenant_id = $2', [request.params.id, tenantId]);
    if (!seg[0]) return reply.code(404).send({ error: 'Campanha não encontrada' });
    const { rows } = await pool.query(
      `select e.id, e.finalidade, e.canal, e.destino, e.status, e.motivo, e.criado_em, c.nome as cliente_nome
       from crm_campanhas_envios e left join crm_clientes c on c.id = e.cliente_id
       where e.campanha_id = $1 order by e.criado_em desc limit 500`,
      [request.params.id]
    );
    return rows;
  });

  // Congela a lista de participantes no momento do sorteio — reabrir o
  // mesmo segmento depois pode trazer clientes diferentes, o sorteio já
  // feito não muda (seção 7.5 do doc: "auditável"). Se a campanha tem prêmio e
  // canal, os ganhadores são avisados.
  fastify.post('/crm/api/segmentos/:id/sortear', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId, userId } = request.user;
    if (!userId) return reply.code(400).send({ error: 'Sessão sem usuário identificado — faça login de novo pra sortear.' });

    const { rows: segRows } = await pool.query('select * from crm_segmentos where id = $1 and tenant_id = $2', [request.params.id, tenantId]);
    if (!segRows[0]) return reply.code(404).send({ error: 'Segmento não encontrado' });

    const resultado = await campanhas.sortearCampanha(pool, {
      tenantId, userId, campanha: segRows[0],
      quantidade: request.body?.quantidade,
      notificar: typeof request.body?.notificar === 'boolean' ? request.body.notificar : null,
    });
    if (resultado.erro) return reply.code(400).send({ error: resultado.erro });
    return reply.code(201).send(resultado.sorteio);
  });

  fastify.get('/crm/api/sorteios', { preHandler: fastify.authenticate }, async (request) => {
    const { rows } = await pool.query(
      `select s.*, seg.nome as segmento_nome from crm_sorteios s
       left join crm_segmentos seg on seg.id = s.segmento_id
       where s.tenant_id = $1 order by s.criado_em desc`,
      [request.user.tenantId]
    );
    return rows;
  });

  // --- Automações (issue #40) -----------------------------------------------
  // V1: só WhatsApp, só funciona pra tenant com número vinculado (ver
  // lib/automacoes.js). Motor de disparo em si fica todo em lib/automacoes.js
  // — aqui é só CRUD de configuração + a lista de templates da Meta pra UI.
  fastify.get('/crm/api/automacoes', { preHandler: fastify.authenticate }, async (request) => {
    const { rows } = await pool.query(
      `select a.*, e.nome as etapa_nome from crm_automacoes a
       left join crm_etapas e on e.id = a.etapa_id
       where a.tenant_id = $1 order by a.criado_em desc`,
      [request.user.tenantId]
    );
    return rows;
  });

  fastify.get('/crm/api/automacoes/templates-whatsapp', { preHandler: fastify.authenticate }, async () => {
    return listarTemplates();
  });

  fastify.post('/crm/api/automacoes', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const { nome, gatilho, etapa_id, whatsapp_template } = request.body || {};
    if (!nome) return reply.code(400).send({ error: 'Nome é obrigatório' });
    if (!GATILHOS_VALIDOS.includes(gatilho)) return reply.code(400).send({ error: `Gatilho inválido. Válidos: ${GATILHOS_VALIDOS.join(', ')}` });
    if ((gatilho === 'mudanca_etapa' || gatilho === 'pedido_parado') && !etapa_id) {
      return reply.code(400).send({ error: 'Esse gatilho exige uma etapa' });
    }
    if (etapa_id) {
      const { rows: etapaRows } = await pool.query('select 1 from crm_etapas where id = $1 and tenant_id = $2', [etapa_id, tenantId]);
      if (!etapaRows[0]) return reply.code(400).send({ error: 'Etapa inválida' });
    }
    const { rows } = await pool.query(
      `insert into crm_automacoes (tenant_id, nome, gatilho, etapa_id, whatsapp_template)
       values ($1, $2, $3, $4, $5) returning *`,
      [tenantId, nome, gatilho, etapa_id || null, whatsapp_template || null]
    );
    return reply.code(201).send(rows[0]);
  });

  fastify.patch('/crm/api/automacoes/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const campos = ['nome', 'whatsapp_template', 'ativo', 'etapa_id'];
    const body = request.body || {};
    const sets = [];
    const params = [request.params.id, tenantId];
    for (const campo of campos) {
      if (body[campo] === undefined) continue;
      params.push(body[campo]);
      sets.push(`${campo} = $${params.length}`);
    }
    if (sets.length === 0) return reply.code(400).send({ error: 'Nenhum campo pra atualizar' });
    const { rows } = await pool.query(
      `update crm_automacoes set ${sets.join(', ')}, atualizado_em = now() where id = $1 and tenant_id = $2 returning *`,
      params
    );
    if (!rows[0]) return reply.code(404).send({ error: 'Automação não encontrada' });
    return rows[0];
  });

  fastify.delete('/crm/api/automacoes/:id', { preHandler: fastify.authenticate }, async (request) => {
    await pool.query('delete from crm_automacoes where id = $1 and tenant_id = $2', [request.params.id, request.user.tenantId]);
    return { ok: true };
  });

  // --- Painel Hoje (seção 7.6) -------------------------------------------------
  fastify.get('/crm/api/painel-hoje', { preHandler: fastify.authenticate }, async (request) => {
    const { tenantId } = request.user;

    const [orcamentosParados, pagamentosPendentes, aniversariantes, etapaProntoId] = await Promise.all([
      pool.query(
        `select p.id, p.cliente_id, p.criado_em, p.etapa_id, c.nome as cliente_nome, c.telefone as cliente_telefone, e.nome as etapa_nome,
                extract(day from now() - p.entrou_na_etapa_em)::int as dias_parado
         from crm_pedidos p
         join crm_etapas e on e.id = p.etapa_id
         join crm_clientes c on c.id = p.cliente_id
         where p.tenant_id = $1 and e.tipo = 'aberta' and e.prazo_alerta_dias is not null
           and p.entrou_na_etapa_em < now() - (e.prazo_alerta_dias || ' days')::interval
         order by dias_parado desc`,
        [tenantId]
      ),
      pool.query(
        `select p.id, p.cliente_id, p.criado_em, c.nome as cliente_nome, c.telefone as cliente_telefone, p.valor_total, p.valor_recebido
         from crm_pedidos p
         join crm_etapas e on e.id = p.etapa_id
         join crm_clientes c on c.id = p.cliente_id
         where p.tenant_id = $1 and e.tipo = 'aberta' and p.status_pagamento in ('pendente', 'parcial')
         order by p.criado_em`,
        [tenantId]
      ),
      // Aniversariantes DO MÊS (pedido do Bruno, 2026-10-03 — era só "hoje"),
      // ordenado a partir do dia de hoje e dando a volta no mês (dia 31 antes
      // do dia 1, se hoje for dia 20, por exemplo) — "% 31" como teto seguro
      // de dias num mês, só pra ordenar (não representa uma data real).
      // Mostra todo mundo com aniversário no mês, mesmo sem telefone — um
      // filtro `telefone is not null` aqui (tentativa anterior de "sempre
      // ter os ícones") sumia com a pessoa inteira da lista quando ela não
      // tinha telefone, o que é pior do que ela aparecer sem os ícones de
      // ação (ver acoesClienteHtml, shell.js, que agora mostra os ícones
      // desabilitados em vez de sumir).
      pool.query(
        `select id, nome, telefone, email, extract(day from data_nascimento)::int as dia_nascimento
         from crm_clientes
         where tenant_id = $1 and data_nascimento is not null
           and extract(month from data_nascimento) = extract(month from current_date)
         order by (extract(day from data_nascimento)::int - extract(day from current_date)::int + 31) % 31`,
        [tenantId]
      ),
      buscarEtapaPronto(pool, tenantId),
    ]);

    let prontosParaEnvio = [];
    if (etapaProntoId) {
      const { rows } = await pool.query(
        `select p.id, p.cliente_id, c.nome as cliente_nome, c.telefone as cliente_telefone, p.tipo_entrega
         from crm_pedidos p join crm_clientes c on c.id = p.cliente_id
         where p.tenant_id = $1 and p.etapa_id = $2`,
        [tenantId, etapaProntoId]
      );
      prontosParaEnvio = rows;
    }

    return {
      orcamentos_parados: orcamentosParados.rows,
      pagamentos_pendentes: pagamentosPendentes.rows,
      prontos_para_envio: prontosParaEnvio,
      aniversariantes: aniversariantes.rows,
      // "Com quem preciso falar hoje?": conversas que o agente encaminhou para a equipe
      encaminhamentos: await atendimento.listarEncaminhamentos(pool, tenantId),
    };
  });


  // --- Atendimento (agente de IA): conversas, sugestões, assumir/devolver ---------------
  // Tenant sempre do token. Erros de regra de negócio (ErroAtendimento) viram o status certo.
  const atende = (fn) => async (request, reply) => {
    try {
      return await fn(request, reply);
    } catch (e) {
      if (e instanceof atendimento.ErroAtendimento) return reply.code(e.status).send({ error: e.message });
      throw e;
    }
  };
  const depsEnvio = () => ({ enviarTexto: fastify.agente.deps.enviarTexto || enviarTexto, agora: fastify.agente.deps.agora });

  fastify.get('/crm/api/agente/config', { preHandler: fastify.authenticate }, async (request) => atendimento.obterConfig(pool, request.user.tenantId));

  fastify.put('/crm/api/agente/config', { preHandler: fastify.authenticate }, atende(async (request) => {
    const { tenantId, userId } = request.user;
    return atendimento.definirModo(pool, tenantId, userId, (request.body || {}).modo);
  }));

  // Indicadores do agente: custo (IA + mensagens), bloqueios do filtro, qualidade das sugestões, tempo até o 1º atendimento humano, fila e alertas.
  fastify.get('/crm/api/agente/metricas', { preHandler: fastify.authenticate }, async (request) =>
    require('./lib/agente/metricas').calcular(pool, request.user.tenantId, { dias: request.query.dias }));

  fastify.get('/crm/api/agente/resumo', { preHandler: fastify.authenticate }, async (request) => ({
    encaminhamentos_abertos: await atendimento.contarAbertos(pool, request.user.tenantId),
  }));

  fastify.get('/crm/api/agente/conversas', { preHandler: fastify.authenticate }, async (request) =>
    atendimento.listarConversas(pool, request.user.tenantId, { situacao: request.query.situacao }));

  fastify.get('/crm/api/agente/conversas/:id', { preHandler: fastify.authenticate }, atende(async (request) =>
    atendimento.obterConversa(pool, request.user.tenantId, request.params.id)));

  fastify.post('/crm/api/agente/conversas/:id/assumir', { preHandler: fastify.authenticate }, atende(async (request) => {
    const { tenantId, userId } = request.user;
    return atendimento.assumir(pool, tenantId, userId, request.params.id);
  }));

  fastify.post('/crm/api/agente/conversas/:id/devolver', { preHandler: fastify.authenticate }, atende(async (request) => {
    const { tenantId, userId } = request.user;
    return atendimento.devolverAoAgente(pool, tenantId, userId, request.params.id);
  }));

  fastify.post('/crm/api/agente/conversas/:id/encerrar', { preHandler: fastify.authenticate }, atende(async (request) => {
    const { tenantId, userId } = request.user;
    return atendimento.encerrar(pool, tenantId, userId, request.params.id);
  }));

  fastify.post('/crm/api/agente/conversas/:id/mensagens', { preHandler: fastify.authenticate }, atende(async (request) => {
    const { tenantId, userId } = request.user;
    return atendimento.responderComoHumano(pool, tenantId, userId, request.params.id, (request.body || {}).texto, depsEnvio());
  }));

  fastify.post('/crm/api/agente/sugestoes/:id/enviar', { preHandler: fastify.authenticate }, atende(async (request) => {
    const { tenantId, userId } = request.user;
    return atendimento.enviarSugestao(pool, tenantId, userId, request.params.id, (request.body || {}).texto, depsEnvio());
  }));

  fastify.post('/crm/api/agente/sugestoes/:id/descartar', { preHandler: fastify.authenticate }, atende(async (request) => {
    const { tenantId, userId } = request.user;
    return atendimento.descartarSugestao(pool, tenantId, userId, request.params.id);
  }));

  fastify.post('/crm/api/pedidos/:id/revisado', { preHandler: fastify.authenticate }, atende(async (request) => {
    const { tenantId, userId } = request.user;
    return atendimento.marcarPedidoRevisado(pool, tenantId, userId, request.params.id);
  }));

  // Anexo recebido pelo agente (imagem, STL...) — só do próprio tenant; o front busca com Bearer e abre como blob.
  fastify.get('/crm/api/agente/anexos/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const { rows: [a] } = await pool.query('select * from crm_anexos where tenant_id = $1 and id = $2', [tenantId, request.params.id]);
    if (!a) return reply.code(404).send({ error: 'Anexo não encontrado' });
    let buffer;
    try {
      buffer = await fastify.agente.deps.armazenamento.ler(tenantId, a.chave_armazenamento);
    } catch (e) {
      return reply.code(404).send({ error: 'Arquivo indisponível' });
    }
    const nome = encodeURIComponent(a.nome_arquivo || 'arquivo');
    return reply.header('Content-Type', a.mime || 'application/octet-stream').header('Content-Disposition', "inline; filename*=UTF-8''" + nome)
      .header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "sandbox; default-src 'none'").send(buffer);
  });

  // --- Resumo (card do Painel Hoje, pedido do Bruno 2026-10-03) ---------------
  // Parte padrão do Painel Hoje, sempre ativa (sem toggle por tenant).
  // "Pedidos próximos da entrega" usa uma janela fixa de 7 dias — mesmo
  // princípio de default simples e documentado já usado em
  // lib/bot-whatsapp.js (horário comercial) antes de virar configurável, só
  // que aqui não foi pedido pra ser configurável.
  fastify.get('/crm/api/painel-hoje/resumo', { preHandler: fastify.authenticate }, async (request) => {
    const { tenantId } = request.user;
    const [porEtapa, hoje, atendimentosBot, proximosEntrega] = await Promise.all([
      pool.query(
        `select e.id as etapa_id, e.nome as etapa_nome, count(p.id)::int as quantidade
         from crm_etapas e left join crm_pedidos p on p.etapa_id = e.id
         where e.tenant_id = $1 group by e.id, e.nome, e.ordem order by e.ordem`,
        [tenantId]
      ),
      pool.query(
        `select count(*)::int as quantidade, coalesce(sum(p.valor_total), 0) as valor_total
         from crm_pedidos p join crm_etapas e on e.id = p.etapa_id
         where p.tenant_id = $1 and p.criado_em::date = current_date and e.tipo != 'perdida'`,
        [tenantId]
      ),
      pool.query(
        `select count(distinct telefone_e164)::int as quantidade from crm_mensagens_whatsapp
         where tenant_id = $1 and direcao = 'recebida' and criado_em::date = current_date`,
        [tenantId]
      ),
      pool.query(
        `select count(*)::int as quantidade from crm_pedidos p join crm_etapas e on e.id = p.etapa_id
         where p.tenant_id = $1 and e.tipo != 'perdida'
           and p.data_entrega between current_date and current_date + interval '7 days'`,
        [tenantId]
      ),
    ]);
    return {
      pedidos_por_etapa: porEtapa.rows,
      novos_pedidos_dia: hoje.rows[0].quantidade,
      valor_total_dia: hoje.rows[0].valor_total,
      atendimentos_bot_dia: atendimentosBot.rows[0].quantidade,
      pedidos_proximos_entrega: proximosEntrega.rows[0].quantidade,
    };
  });

  // --- Notificações (balão do topo + Configurações > Notificações) -------------
  // Cálculo dos pendentes por tipo vive em lib/notificacoes.js — aqui é só
  // leitura (GET) e o save de qual tipo está ativo/config extra (PATCH),
  // mesmo desenho do kyvvo-studio.
  fastify.get('/crm/api/notificacoes', { preHandler: fastify.authenticate }, async (request) => {
    const { tenantId } = request.user;
    const { rows } = await pool.query('select notificacoes_ativas from crm_configuracoes where tenant_id = $1', [tenantId]);
    const notificacoesAtivas = rows[0] && rows[0].notificacoes_ativas;
    const notificacoes = await listarNotificacoesPendentes(pool, tenantId, notificacoesAtivas);
    return { notificacoes };
  });

  fastify.get('/crm/api/notificacoes/config', { preHandler: fastify.authenticate }, async (request) => {
    const { rows } = await pool.query(
      'select notificacoes_ativas, notificacao_email, notificacao_whatsapp from crm_configuracoes where tenant_id = $1',
      [request.user.tenantId]
    );
    const config = rows[0] || {};
    return {
      notificacoes_ativas: config.notificacoes_ativas || {},
      notificacao_email: config.notificacao_email || '',
      notificacao_whatsapp: config.notificacao_whatsapp || '',
    };
  });

  fastify.patch('/crm/api/notificacoes/config', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const { notificacoes_ativas, notificacao_email, notificacao_whatsapp } = request.body || {};
    if (!notificacoes_ativas || typeof notificacoes_ativas !== 'object') {
      return reply.code(400).send({ error: 'notificacoes_ativas é obrigatório' });
    }
    // Normaliza pro mesmo formato E.164 (+55DDNNNNNNNNN) usado em
    // crm_clientes.telefone — a tela manda o valor já mascarado
    // ((34) 99999-9888), e enviarWhatsappNotificacao manda esse valor direto
    // pro `to` da Cloud API sem conversão nenhuma, então precisa estar
    // normalizado aqui, não só bonito na tela.
    const { rows } = await pool.query(
      `insert into crm_configuracoes (tenant_id, notificacoes_ativas, notificacao_email, notificacao_whatsapp, atualizado_em)
       values ($1, $2, $3, $4, now())
       on conflict (tenant_id) do update set
         notificacoes_ativas = $2, notificacao_email = $3, notificacao_whatsapp = $4, atualizado_em = now()
       returning notificacoes_ativas, notificacao_email, notificacao_whatsapp`,
      [tenantId, JSON.stringify(notificacoes_ativas), notificacao_email ? notificacao_email.trim().toLowerCase() : null, notificacao_whatsapp ? paraE164(notificacao_whatsapp) : null]
    );
    return rows[0];
  });

  // --- Configurações > Geral (pedido do Bruno, 2026-10-03) -------------------
  // Horário de atendimento humano do bot (antes fixo em lib/bot-whatsapp.js),
  // tempo de retomada de conversa parada e dias de visibilidade da última
  // coluna do Quadro — mesmo padrão de upsert em crm_configuracoes já usado
  // pelas Notificações, só tocando as colunas desta tela.
  fastify.get('/crm/api/configuracoes-gerais', { preHandler: fastify.authenticate }, async (request) => {
    const { rows } = await pool.query(
      `select horario_atendimento_inicio, horario_atendimento_fim, bot_retomada_horas, quadro_dias_ultima_coluna,
              mensagem_aviso_pedido, mensagem_aviso_pedido_ativo
       from crm_configuracoes where tenant_id = $1`,
      [request.user.tenantId]
    );
    const config = rows[0] || {};
    return {
      horario_atendimento_inicio: config.horario_atendimento_inicio ?? 8,
      horario_atendimento_fim: config.horario_atendimento_fim ?? 18,
      bot_retomada_horas: config.bot_retomada_horas ?? 24,
      quadro_dias_ultima_coluna: config.quadro_dias_ultima_coluna ?? 30,
      mensagem_aviso_pedido: config.mensagem_aviso_pedido ?? '📦 Pedido de canal próprio — não esqueça o cartão de recompra no kit.',
      mensagem_aviso_pedido_ativo: config.mensagem_aviso_pedido_ativo ?? true,
    };
  });

  fastify.patch('/crm/api/configuracoes-gerais', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const {
      horario_atendimento_inicio: inicio, horario_atendimento_fim: fim, bot_retomada_horas: retomadaHoras,
      quadro_dias_ultima_coluna: diasUltimaColuna, mensagem_aviso_pedido: mensagemAviso, mensagem_aviso_pedido_ativo: mensagemAvisoAtiva,
    } = request.body || {};
    if (![inicio, fim, retomadaHoras, diasUltimaColuna].every((v) => Number.isInteger(v))) {
      return reply.code(400).send({ error: 'Todos os campos são obrigatórios e precisam ser números inteiros' });
    }
    if (inicio < 0 || inicio > 23 || fim < 0 || fim > 23 || fim <= inicio) {
      return reply.code(400).send({ error: 'Horário inválido — início e fim precisam estar entre 0 e 23, com fim depois do início' });
    }
    if (retomadaHoras < 1 || diasUltimaColuna < 1) {
      return reply.code(400).send({ error: 'Tempo de retomada e dias da última coluna precisam ser pelo menos 1' });
    }
    if (typeof mensagemAviso !== 'string' || !mensagemAviso.trim()) {
      return reply.code(400).send({ error: 'Mensagem de aviso do pedido é obrigatória' });
    }
    const { rows } = await pool.query(
      `insert into crm_configuracoes (tenant_id, horario_atendimento_inicio, horario_atendimento_fim, bot_retomada_horas, quadro_dias_ultima_coluna, mensagem_aviso_pedido, mensagem_aviso_pedido_ativo, atualizado_em)
       values ($1, $2, $3, $4, $5, $6, $7, now())
       on conflict (tenant_id) do update set
         horario_atendimento_inicio = $2, horario_atendimento_fim = $3, bot_retomada_horas = $4, quadro_dias_ultima_coluna = $5,
         mensagem_aviso_pedido = $6, mensagem_aviso_pedido_ativo = $7, atualizado_em = now()
       returning horario_atendimento_inicio, horario_atendimento_fim, bot_retomada_horas, quadro_dias_ultima_coluna, mensagem_aviso_pedido, mensagem_aviso_pedido_ativo`,
      [tenantId, inicio, fim, retomadaHoras, diasUltimaColuna, mensagemAviso.trim(), !!mensagemAvisoAtiva]
    );
    return rows[0];
  });

  fastify.patch('/crm/api/notificacoes/:id/lida', { preHandler: fastify.authenticate }, async (request, reply) => {
    const ok = await marcarNotificacaoLida(pool, request.user.tenantId, request.params.id);
    if (!ok) return reply.code(404).send({ error: 'Notificação não encontrada' });
    return { ok: true };
  });

  fastify.post('/crm/api/notificacoes/marcar-todas-lidas', { preHandler: fastify.authenticate }, async (request) => {
    const marcadas = await marcarTodasNotificacoesLidas(pool, request.user.tenantId);
    return { ok: true, marcadas };
  });

  fastify.get('/crm/api/notificacoes/historico', { preHandler: fastify.authenticate }, async (request) => {
    return listarHistoricoNotificacoes(pool, request.user.tenantId, request.query || {});
  });

  return fastify;
}

async function start() {
  const fastify = await build();
  try {
    await migrar();
    fastify.agente.iniciarVarredura();
    fastify.agente.iniciarRetencao();
    // Checador dos gatilhos de automação sem evento síncrono (pedido parado
    // numa etapa, aniversário do cliente) — granularidade de dia, de hora em
    // hora é sobra. Só em start() (não em build(), usado pelos testes) pra
    // não deixar um interval pendurado no processo de teste.
    setInterval(() => {
      checarGatilhosPeriodicos(pool).catch((err) => fastify.log.error(`[automacoes] checador periódico: ${err.message}`));
      checarConversasParaRetomar(pool).catch((err) => fastify.log.error(`[bot-whatsapp] checador de retomada: ${err.message}`));
    }, 60 * 60 * 1000);
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

if (require.main === module) {
  start();
}

module.exports = { build };
