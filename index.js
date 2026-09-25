require('dotenv').config();

const path = require('path');
const fs = require('fs');
const Fastify = require('fastify');
const fastifyJwt = require('@fastify/jwt');
const fastifyStatic = require('@fastify/static');
const fastifyMultipart = require('@fastify/multipart');

const { pool, migrar } = require('./lib/db');
const { paraE164 } = require('./lib/telefone');
const { encontrarOuCriarPorTelefone, buscarMetricas } = require('./lib/clientes');
const { inicializarModelosPadrao } = require('./lib/mensagens');
const { resolverSegmento } = require('./lib/segmentos');
const { inicializarEtapasPadrao, buscarEtapaPronto } = require('./lib/etapas');
const { buscarSugestoesDuplicados, mesclarClientes } = require('./lib/duplicados');
const { parseCsv, importarClientesCsv, parseNfeXml, importarNfe, importarRelatorioUpseller } = require('./lib/importacoes');
const { tenantPrecisaOnboarding, confirmarOnboarding } = require('./lib/onboarding');
const { processarMensagem } = require('./lib/bot-whatsapp');
const { DIR_UPLOADS } = require('./lib/whatsapp-media');
const { enviarTexto, enviarBotoes, enviarLista, listarTemplates } = require('@kyvvohq/whatsapp');
const { dispararMudancaEtapa, dispararPedidoCriado, checarGatilhosPeriodicos, GATILHOS_VALIDOS } = require('./lib/automacoes');

const PORT = process.env.PORT || 3005;

// Identidade/sessão: kyvvo-platform, mesmo serviço que Studio e People usam
// (endereço interno na rede do compose). Ver kyvvo-people/index.js — mesmo
// padrão: o CRM nunca vê/toca usuarios/tenants diretamente, só confia numa
// checagem servidor-a-servidor e emite seu próprio JWT interno depois.
const PLATFORM_URL = process.env.PLATFORM_URL || 'http://platform:3003';

async function build() {
  const fastify = Fastify({ logger: true });

  fastify.register(fastifyJwt, { secret: process.env.CRM_JWT_SECRET });

  fastify.decorate('authenticate', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Não autenticado' });
    }
  });

  fastify.register(fastifyStatic, {
    root: path.join(__dirname, 'public'),
    prefix: '/crm/',
  });

  fastify.register(fastifyStatic, {
    root: path.join(__dirname, 'node_modules', '@kyvvohq', 'design-system'),
    prefix: '/ds/',
    decorateReply: false,
  });

  fastify.register(fastifyMultipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 20 },
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
      const change = (((body.entry || [])[0] || {}).changes || [])[0];
      const value = change ? change.value : null;
      const phoneNumberId = value && value.metadata && value.metadata.phone_number_id;
      const msg = value && (value.messages || [])[0];
      const entrada = msg ? extrairEntradaBot(msg) : null;
      // Meta manda o nome do perfil do contato em quase toda mensagem — só é
      // usado se o cliente ainda não tiver cadastro (ver encontrarOuCriarPorTelefone).
      const nomeWhatsapp = value && Array.isArray(value.contacts) && value.contacts[0] && value.contacts[0].profile
        ? value.contacts[0].profile.name : null;

      if (entrada && phoneNumberId) {
        const { rows } = await pool.query('select tenant_id from crm_whatsapp_numeros where phone_number_id = $1', [phoneNumberId]);
        const tenantId = rows[0] && rows[0].tenant_id;
        const telefoneE164 = tenantId ? paraE164(msg.from) : null;

        if (!tenantId) {
          request.log.warn(`[bot-whatsapp] phone_number_id ${phoneNumberId} sem tenant vinculado (crm_whatsapp_numeros) — mensagem ignorada`);
        } else if (telefoneE164) {
          const envios = await processarMensagem(pool, { tenantId, telefoneE164, entrada, nomeWhatsapp });
          for (const envio of envios) {
            if (envio.tipo === 'botoes') {
              await enviarBotoes({ to: telefoneE164, texto: envio.texto, botoes: envio.botoes, phoneNumberId });
            } else if (envio.tipo === 'lista') {
              await enviarLista({ to: telefoneE164, texto: envio.texto, tituloBotao: envio.tituloBotao, opcoes: envio.opcoes, phoneNumberId });
            } else {
              await enviarTexto({ to: telefoneE164, texto: envio.texto, phoneNumberId });
            }
          }
        }
      }
    } catch (err) {
      request.log.error(`[bot-whatsapp] Falha ao processar: ${err.message}`);
    }
    return reply.code(200).send({ ok: true });
  });

  // --- Auth ----------------------------------------------------------------
  // POST /api/auth/crm/acesso ainda não existe no kyvvo-platform — precisa
  // do módulo 'crm' cadastrado lá (ver PR companion em kyvvo-platform e
  // docs/DECISOES-PENDENTES.md #2 deste repo).
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
        body: JSON.stringify({ email, senha }),
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
    const { token: kyvvoToken, nome } = await loginRes.json();

    let acessoRes;
    try {
      acessoRes = await fetch(`${PLATFORM_URL}/api/auth/crm/acesso`, {
        headers: { Authorization: `Bearer ${kyvvoToken}` },
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

    // userId vem do payload do token do platform (RS256, confiamos na
    // resposta HTTPS do próprio serviço que acabamos de chamar — mesmo
    // princípio do register mais abaixo) — precisa dele pra registrar quem
    // fez uma ação sensível (ex.: ator do sorteio, seção 7.5 do doc).
    let userId;
    try {
      userId = JSON.parse(Buffer.from(kyvvoToken.split('.')[1], 'base64url').toString('utf8')).userId;
    } catch {
      userId = null;
    }

    await inicializarEtapasPadrao(pool, tenantId);
    await inicializarModelosPadrao(pool, tenantId);
    const onboardingPendente = await tenantPrecisaOnboarding(pool, tenantId);

    const token = fastify.jwt.sign({ tenantId, userId, email, nome }, { expiresIn: '12h' });
    return { token, nome, onboarding_pendente: onboardingPendente };
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
    let userId;
    try {
      const payload = JSON.parse(Buffer.from(dados.token.split('.')[1], 'base64url').toString('utf8'));
      tenantId = payload.tenantId;
      userId = payload.userId;
    } catch (err) {
      request.log.error(`Conta criada no platform mas não consegui ler o tenantId do token: ${err.message}`);
      return reply.code(502).send({ error: 'Conta criada, mas não foi possível iniciar sua sessão. Faça login manualmente.' });
    }

    await inicializarEtapasPadrao(pool, tenantId);
    await inicializarModelosPadrao(pool, tenantId);
    const onboardingPendente = await tenantPrecisaOnboarding(pool, tenantId);
    const token = fastify.jwt.sign({ tenantId, userId, email: dados.email, nome: dados.nome }, { expiresIn: '12h' });
    return reply.code(201).send({ token, nome: dados.nome, onboarding_pendente: onboardingPendente });
  });

  // --- Clientes --------------------------------------------------------------
  fastify.get('/crm/api/clientes', { preHandler: fastify.authenticate }, async (request) => {
    const { tenantId } = request.user;
    const busca = (request.query.busca || '').trim();
    const params = [tenantId];
    let filtro = '';
    if (busca) {
      params.push(`%${busca.toLowerCase()}%`);
      filtro = `and (lower(nome) like $2 or telefone like $2 or cpf like $2)`;
    }
    const { rows } = await pool.query(
      `select id, nome, telefone, email, cidade, uf, origem, segmento, bloqueado, criado_em
       from crm_clientes where tenant_id = $1 ${filtro}
       order by nome limit 200`,
      params
    );
    return rows;
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
                ), '[]') as arquivos
         from crm_pedidos p
         join crm_etapas e on e.id = p.etapa_id
         where p.cliente_id = $1 order by p.criado_em desc`,
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

  fastify.post('/crm/api/importacoes/nfe', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const arquivos = [];
    for await (const part of request.parts()) {
      if (part.type === 'file') arquivos.push({ nome: part.filename, buffer: await part.toBuffer() });
    }
    if (!arquivos.length) return reply.code(400).send({ error: 'Envie ao menos um arquivo XML' });

    let criados = 0, atualizados = 0, comErro = 0;
    const notas = [];
    for (const arquivo of arquivos) {
      try {
        const nfeData = parseNfeXml(arquivo.buffer.toString('utf8'));
        const resultado = await importarNfe(pool, tenantId, nfeData, arquivo.nome);
        if (resultado.status === 'criado') criados++;
        else if (resultado.status === 'conciliado') atualizados++;
        notas.push(`${arquivo.nome}: ${resultado.status}`);
      } catch (erro) {
        comErro++;
        notas.push(`${arquivo.nome}: erro — ${erro.message}`);
      }
    }

    const { rows } = await pool.query(
      `insert into crm_importacoes (tenant_id, tipo, arquivo, status, criados, atualizados, com_erro, erro, concluido_em)
       values ($1, 'nfe_xml', $2, 'concluido', $3, $4, $5, $6, now()) returning *`,
      [tenantId, arquivos.length === 1 ? arquivos[0].nome : `${arquivos.length} arquivos`, criados, atualizados, comErro, notas.join(' | ') || null]
    );
    return reply.code(201).send(rows[0]);
  });

  // Relatório de pedidos da UpSeller (Excel) — colunas fixas, sem tela de
  // mapeamento (schema confirmado com arquivo real, ver lib/importacoes.js).
  fastify.post('/crm/api/importacoes/upseller', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    let arquivoBuffer = null, nomeArquivo = null;
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        arquivoBuffer = await part.toBuffer();
        nomeArquivo = part.filename;
      }
    }
    if (!arquivoBuffer) return reply.code(400).send({ error: 'Arquivo é obrigatório' });

    let resultado;
    try {
      resultado = await importarRelatorioUpseller(pool, tenantId, arquivoBuffer, nomeArquivo || 'relatorio.xlsx');
    } catch (erro) {
      return reply.code(400).send({ error: erro.message });
    }
    return reply.code(201).send(resultado);
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
  fastify.get('/crm/api/pedidos', { preHandler: fastify.authenticate }, async (request) => {
    const { tenantId } = request.user;
    const { etapa_id, recurso_id, status_pagamento, prioridade, cliente_id } = request.query || {};
    const condicoes = ['p.tenant_id = $1'];
    const params = [tenantId];
    if (etapa_id) { params.push(etapa_id); condicoes.push(`p.etapa_id = $${params.length}`); }
    if (recurso_id) { params.push(recurso_id); condicoes.push(`p.recurso_id = $${params.length}`); }
    if (status_pagamento) { params.push(status_pagamento); condicoes.push(`p.status_pagamento = $${params.length}`); }
    if (prioridade) { params.push(prioridade); condicoes.push(`p.prioridade = $${params.length}`); }
    if (cliente_id) { params.push(cliente_id); condicoes.push(`p.cliente_id = $${params.length}`); }

    const { rows } = await pool.query(
      `select p.*, c.nome as cliente_nome, c.telefone as cliente_telefone, r.nome as recurso_nome,
              extract(day from now() - p.entrou_na_etapa_em)::int as dias_na_etapa,
              coalesce((select sum(quantidade) from crm_pedidos_itens where pedido_id = p.id), 0) as quantidade_itens
       from crm_pedidos p
       join crm_clientes c on c.id = p.cliente_id
       left join crm_recursos r on r.id = p.recurso_id
       where ${condicoes.join(' and ')}
       order by p.criado_em desc`,
      params
    );
    return rows;
  });

  // Criação rápida (seção 7.2): telefone (acha ou cria cliente), itens ou
  // descrição livre + quantidade, valor, origem, tipo de entrega, recurso
  // (raia) opcional. Resto é opcional.
  fastify.post('/crm/api/pedidos', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const { telefone, nome_cliente, itens, descricao, quantidade, produto_id, valor_total, origem, tipo_entrega, recurso_id } = request.body || {};
    if (!origem) return reply.code(400).send({ error: 'Origem é obrigatória' });

    const { rows: etapaRows } = await pool.query(
      `select id from crm_etapas where tenant_id = $1 and tipo = 'aberta' order by ordem asc limit 1`,
      [tenantId]
    );
    if (!etapaRows[0]) return reply.code(409).send({ error: 'Conta sem etapas configuradas' });

    const cliente = await encontrarOuCriarPorTelefone(pool, tenantId, { telefone, nome: nome_cliente, origem });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: pedidoRows } = await client.query(
        `insert into crm_pedidos (tenant_id, cliente_id, etapa_id, origem, valor_total, tipo_entrega, recurso_id)
         values ($1, $2, $3, $4, $5, $6, $7) returning *`,
        [tenantId, cliente.id, etapaRows[0].id, origem, valor_total || 0, tipo_entrega || null, recurso_id || null]
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
  fastify.get('/crm/api/produtos', { preHandler: fastify.authenticate }, async (request) => {
    const { rows } = await pool.query('select * from crm_produtos where tenant_id = $1 order by nome', [request.user.tenantId]);
    return rows;
  });

  fastify.post('/crm/api/produtos', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const { nome, categoria, preco_referencia, identificador_externo } = request.body || {};
    if (!nome || !nome.trim()) return reply.code(400).send({ error: 'Nome é obrigatório' });
    const { rows } = await pool.query(
      `insert into crm_produtos (tenant_id, nome, categoria, preco_referencia, identificador_externo)
       values ($1, $2, $3, $4, $5) returning *`,
      [tenantId, nome.trim(), categoria || null, preco_referencia || null, identificador_externo || null]
    );
    return reply.code(201).send(rows[0]);
  });

  fastify.patch('/crm/api/produtos/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const campos = ['nome', 'categoria', 'preco_referencia', 'identificador_externo'];
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
  // Sem POST/DELETE livre: as 4 chaves mapeiam pra pontos fixos do código
  // (Painel Hoje), então só editar o texto faz sentido no MVP.
  fastify.get('/crm/api/modelos-mensagem', { preHandler: fastify.authenticate }, async (request) => {
    const { rows } = await pool.query('select * from crm_modelos_mensagem where tenant_id = $1 order by chave', [request.user.tenantId]);
    return rows;
  });

  fastify.patch('/crm/api/modelos-mensagem/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    const texto = (request.body?.texto || '').trim();
    if (!texto) return reply.code(400).send({ error: 'Texto é obrigatório' });
    const { rows } = await pool.query(
      'update crm_modelos_mensagem set texto = $1 where id = $2 and tenant_id = $3 returning *',
      [texto, request.params.id, request.user.tenantId]
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

  // --- Segmentos e sorteio (US23/US24) --------------------------------------------
  fastify.post('/crm/api/segmentos/preview', { preHandler: fastify.authenticate }, async (request) => {
    const clientes = await resolverSegmento(pool, request.user.tenantId, request.body?.filtros);
    return { total: clientes.length, clientes };
  });

  fastify.get('/crm/api/segmentos', { preHandler: fastify.authenticate }, async (request) => {
    const { rows } = await pool.query('select * from crm_segmentos where tenant_id = $1 order by criado_em desc', [request.user.tenantId]);
    return rows;
  });

  fastify.post('/crm/api/segmentos', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const { nome, filtros } = request.body || {};
    if (!nome || !nome.trim()) return reply.code(400).send({ error: 'Nome é obrigatório' });
    const { rows } = await pool.query(
      'insert into crm_segmentos (tenant_id, nome, filtros) values ($1, $2, $3) returning *',
      [tenantId, nome.trim(), JSON.stringify(filtros || {})]
    );
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

  // Congela a lista de participantes no momento do sorteio — reabrir o
  // mesmo segmento depois pode trazer clientes diferentes, o sorteio já
  // feito não muda (seção 7.5 do doc: "auditável").
  fastify.post('/crm/api/segmentos/:id/sortear', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId, userId } = request.user;
    if (!userId) return reply.code(400).send({ error: 'Sessão sem usuário identificado — faça login de novo pra sortear.' });

    const { rows: segRows } = await pool.query('select * from crm_segmentos where id = $1 and tenant_id = $2', [request.params.id, tenantId]);
    if (!segRows[0]) return reply.code(404).send({ error: 'Segmento não encontrado' });

    const participantes = await resolverSegmento(pool, tenantId, segRows[0].filtros);
    if (!participantes.length) return reply.code(400).send({ error: 'Este segmento não tem nenhum participante agora.' });

    const quantidade = Math.min(Math.max(Number(request.body?.quantidade) || 1, 1), participantes.length);
    const embaralhados = [...participantes].sort(() => Math.random() - 0.5);
    const vencedores = embaralhados.slice(0, quantidade).map((c) => ({ id: c.id, nome: c.nome, telefone: c.telefone }));

    const { rows } = await pool.query(
      `insert into crm_sorteios (tenant_id, segmento_id, participantes, vencedores, ator_id)
       values ($1, $2, $3, $4, $5) returning *`,
      [tenantId, segRows[0].id, JSON.stringify(participantes.map((c) => c.id)), JSON.stringify(vencedores), userId]
    );
    return reply.code(201).send(rows[0]);
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
        `select p.id, p.cliente_id, c.nome as cliente_nome, c.telefone as cliente_telefone, e.nome as etapa_nome,
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
        `select p.id, p.cliente_id, c.nome as cliente_nome, c.telefone as cliente_telefone, p.valor_total, p.valor_recebido
         from crm_pedidos p
         join crm_etapas e on e.id = p.etapa_id
         join crm_clientes c on c.id = p.cliente_id
         where p.tenant_id = $1 and e.tipo = 'aberta' and p.status_pagamento in ('pendente', 'parcial')
         order by p.criado_em`,
        [tenantId]
      ),
      pool.query(
        `select id, nome, telefone from crm_clientes
         where tenant_id = $1 and data_nascimento is not null
           and extract(month from data_nascimento) = extract(month from current_date)
           and extract(day from data_nascimento) = extract(day from current_date)`,
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
    };
  });

  return fastify;
}

async function start() {
  const fastify = await build();
  try {
    await migrar();
    // Checador dos gatilhos de automação sem evento síncrono (pedido parado
    // numa etapa, aniversário do cliente) — granularidade de dia, de hora em
    // hora é sobra. Só em start() (não em build(), usado pelos testes) pra
    // não deixar um interval pendurado no processo de teste.
    setInterval(() => {
      checarGatilhosPeriodicos(pool).catch((err) => fastify.log.error(`[automacoes] checador periódico: ${err.message}`));
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
