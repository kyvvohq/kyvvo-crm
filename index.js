require('dotenv').config();

const path = require('path');
const Fastify = require('fastify');
const fastifyJwt = require('@fastify/jwt');
const fastifyStatic = require('@fastify/static');
const fastifyMultipart = require('@fastify/multipart');

const { pool, migrar } = require('./lib/db');
const { paraE164 } = require('./lib/telefone');
const { encontrarOuCriarPorTelefone, buscarMetricas } = require('./lib/clientes');
const { inicializarEtapasPadrao, buscarEtapaPronto } = require('./lib/etapas');

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
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  });

  fastify.get('/', async (request, reply) => reply.sendFile('index.html'));

  fastify.get('/crm/api/saude', async () => ({ ok: true }));

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

    await inicializarEtapasPadrao(pool, tenantId);

    const token = fastify.jwt.sign({ tenantId, email, nome }, { expiresIn: '12h' });
    return { token, nome };
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
    const token = fastify.jwt.sign({ tenantId, email: dados.email, nome: dados.nome }, { expiresIn: '12h' });
    return reply.code(201).send({ token, nome: dados.nome });
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
      `select id, nome, telefone, email, cidade, uf, origem, criado_em
       from crm_clientes where tenant_id = $1 ${filtro}
       order by nome limit 200`,
      params
    );
    return rows;
  });

  fastify.post('/crm/api/clientes', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const { nome, telefone, email, cpf, cidade, uf, cep, data_nascimento, origem, observacoes } = request.body || {};
    if (!nome) return reply.code(400).send({ error: 'Nome é obrigatório' });

    const { rows } = await pool.query(
      `insert into crm_clientes (tenant_id, nome, telefone, email, cpf, cidade, uf, cep, data_nascimento, origem, observacoes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning *`,
      [tenantId, nome, paraE164(telefone), email || null, cpf || null, cidade || null, uf || null, cep || null, data_nascimento || null, origem || null, observacoes || null]
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

    const [tags, campos, pedidos, eventos, metricas] = await Promise.all([
      pool.query(
        `select t.id, t.nome from crm_tags t
         join crm_clientes_tags ct on ct.tag_id = t.id where ct.cliente_id = $1`,
        [rows[0].id]
      ),
      pool.query(
        `select cc.id, cc.chave, cc.label, cc.tipo, cv.valor from crm_campos_customizados cc
         left join crm_clientes_valores cv on cv.campo_id = cc.id and cv.cliente_id = $1
         where cc.tenant_id = $2 order by cc.ordem`,
        [rows[0].id, tenantId]
      ),
      pool.query(
        `select p.*, e.nome as etapa_nome from crm_pedidos p
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
      campos_customizados: campos.rows,
      pedidos: pedidos.rows,
      eventos: eventos.rows,
      metricas,
    };
  });

  fastify.patch('/crm/api/clientes/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const campos = ['nome', 'telefone', 'email', 'cpf', 'cidade', 'uf', 'cep', 'data_nascimento', 'origem', 'observacoes'];
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

  // --- Etapas (config do funil) ----------------------------------------------
  fastify.get('/crm/api/etapas', { preHandler: fastify.authenticate }, async (request) => {
    const { rows } = await pool.query('select * from crm_etapas where tenant_id = $1 order by ordem', [request.user.tenantId]);
    return rows;
  });

  // --- Pedidos / kanban --------------------------------------------------------
  fastify.get('/crm/api/pedidos', { preHandler: fastify.authenticate }, async (request) => {
    const { tenantId } = request.user;
    const { rows } = await pool.query(
      `select p.*, c.nome as cliente_nome, c.telefone as cliente_telefone,
              extract(day from now() - p.entrou_na_etapa_em)::int as dias_na_etapa
       from crm_pedidos p
       join crm_clientes c on c.id = p.cliente_id
       where p.tenant_id = $1
       order by p.criado_em desc`,
      [tenantId]
    );
    return rows;
  });

  // Criação rápida (seção 7.2): telefone (acha ou cria cliente), itens ou
  // descrição livre, valor, origem, tipo de entrega. Resto é opcional.
  fastify.post('/crm/api/pedidos', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { tenantId } = request.user;
    const { telefone, nome_cliente, itens, descricao, valor_total, origem, tipo_entrega } = request.body || {};
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
        `insert into crm_pedidos (tenant_id, cliente_id, etapa_id, origem, valor_total, tipo_entrega)
         values ($1, $2, $3, $4, $5, $6) returning *`,
        [tenantId, cliente.id, etapaRows[0].id, origem, valor_total || 0, tipo_entrega || null]
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
          `insert into crm_pedidos_itens (pedido_id, descricao, quantidade, valor_unitario)
           values ($1, $2, 1, $3)`,
          [pedido.id, descricao, valor_total || 0]
        );
      }

      await client.query(
        `insert into crm_eventos (tenant_id, cliente_id, pedido_id, tipo) values ($1, $2, $3, 'criacao')`,
        [tenantId, cliente.id, pedido.id]
      );
      await client.query('COMMIT');
      return reply.code(201).send({ ...pedido, cliente });
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    } finally {
      client.release();
    }
  });

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
