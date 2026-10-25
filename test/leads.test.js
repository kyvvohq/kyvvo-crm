const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/none';

const { pool } = require('../lib/db');
const { build } = require('../index');
const platform = require('../lib/platform');

async function tokenTenant() {
  platform.verifyToken = async () => ({ tenantId: 'tenant-1', userId: 'user-1', email: 'a@b.com', tokenVersion: 0 });
  return 'token-fake';
}

// Leads exige perfil_agente='kyvvo_atendimento' (query em crm_agente_config)
// E o módulo 'crm_leads' ativo no admin (GET /entitlements/:tenantId no
// platform) — ver exigeAgenteKyvvo em index.js. Os testes abaixo testam a
// lógica das próprias rotas, não esse gate, então mockam os dois pra sempre
// passar: `pool.query` responde perfil_agente certo pra qualquer SQL que
// mencione a coluna (antes de cair na resposta específica da rota) e
// `fetch` global responde o módulo ativo pra qualquer chamada /entitlements/.
const fetchOriginal = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).includes('/entitlements/')) {
    return { ok: true, json: async () => ({ modulos: ['crm_leads', 'crm_chamados'] }) };
  }
  return fetchOriginal(url, opts);
};

function mockPool(respostaRota) {
  pool.query = async (sql, params) => {
    if (/perfil_agente/.test(sql)) return { rows: [{ perfil_agente: 'kyvvo_atendimento' }] };
    return respostaRota(sql, params);
  };
}

afterEach(() => { delete pool.query; });

test('GET /crm/api/leads: filtra por etapa_id e aberto, devolve lista enriquecida', async () => {
  const app = await build();
  let sqlCapturada;
  mockPool((sql, params) => {
    sqlCapturada = { sql, params };
    return { rows: [{ id: 'lead-1', cliente_nome: 'Ana', etapa_nome: 'Novo lead' }] };
  });
  const token = await tokenTenant();
  const res = await app.inject({
    method: 'GET', url: '/crm/api/leads?etapa_id=etapa-1&aberto=true',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().length, 1);
  assert.match(sqlCapturada.sql, /e\.tipo = 'aberta'/);
  assert.deepEqual(sqlCapturada.params, ['tenant-1', 'etapa-1']);
  await app.close();
});

test('GET /crm/api/leads/:id: 404 quando não encontra', async () => {
  const app = await build();
  mockPool(() => ({ rows: [] }));
  const token = await tokenTenant();
  const res = await app.inject({ method: 'GET', url: '/crm/api/leads/lead-inexistente', headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('PATCH /crm/api/leads/:id/etapa: exige etapa_id', async () => {
  const app = await build();
  mockPool(() => ({ rows: [] }));
  const token = await tokenTenant();
  const res = await app.inject({
    method: 'PATCH', url: '/crm/api/leads/lead-1/etapa',
    headers: { authorization: `Bearer ${token}` }, payload: {},
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('PATCH /crm/api/leads/:id/etapa: move de etapa com sucesso', async () => {
  const app = await build();
  let paramsCapturados;
  mockPool((sql, params) => {
    paramsCapturados = params;
    return { rows: [{ id: 'lead-1', etapa_id: 'etapa-2' }] };
  });
  const token = await tokenTenant();
  const res = await app.inject({
    method: 'PATCH', url: '/crm/api/leads/lead-1/etapa',
    headers: { authorization: `Bearer ${token}` }, payload: { etapa_id: 'etapa-2' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(paramsCapturados, ['tenant-1', 'lead-1', 'etapa-2', null]);
  await app.close();
});

test('POST /crm/api/leads: exige telefone', async () => {
  const app = await build();
  mockPool(() => ({ rows: [] }));
  const token = await tokenTenant();
  const res = await app.inject({ method: 'POST', url: '/crm/api/leads', headers: { authorization: `Bearer ${token}` }, payload: {} });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /crm/api/leads-etapas: exige nome', async () => {
  const app = await build();
  mockPool(() => ({ rows: [] }));
  const token = await tokenTenant();
  const res = await app.inject({ method: 'POST', url: '/crm/api/leads-etapas', headers: { authorization: `Bearer ${token}` }, payload: {} });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('todas as rotas de leads exigem token', async () => {
  const app = await build();
  for (const [method, url] of [
    ['GET', '/crm/api/leads'], ['POST', '/crm/api/leads'], ['GET', '/crm/api/leads/x'], ['PATCH', '/crm/api/leads/x'],
    ['PATCH', '/crm/api/leads/x/etapa'], ['GET', '/crm/api/leads-etapas'], ['POST', '/crm/api/leads-etapas'],
  ]) {
    const res = await app.inject({ method, url });
    assert.equal(res.statusCode, 401, `${method} ${url}`);
  }
  await app.close();
});

test('rotas de leads exigem perfil_agente=kyvvo_atendimento E módulo crm_leads ativo', async () => {
  const app = await build();
  pool.query = async () => ({ rows: [{ perfil_agente: null }] });
  const token = await tokenTenant();
  const res = await app.inject({ method: 'GET', url: '/crm/api/leads', headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 403);
  await app.close();
});
