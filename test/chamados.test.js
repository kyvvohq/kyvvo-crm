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

afterEach(() => { delete pool.query; });

test('GET /crm/api/chamados: filtra por status e urgencia', async () => {
  const app = await build();
  let sqlCapturada;
  pool.query = async (sql, params) => {
    sqlCapturada = { sql, params };
    return { rows: [{ id: 'ch-1', status: 'aberto', urgencia: 'alta' }] };
  };
  const token = await tokenTenant();
  const res = await app.inject({
    method: 'GET', url: '/crm/api/chamados?status=aberto&urgencia=alta',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().length, 1);
  assert.deepEqual(sqlCapturada.params, ['tenant-1', 'aberto', 'alta']);
  await app.close();
});

test('GET /crm/api/chamados/:id: 404 quando não encontra', async () => {
  const app = await build();
  pool.query = async () => ({ rows: [] });
  const token = await tokenTenant();
  const res = await app.inject({ method: 'GET', url: '/crm/api/chamados/inexistente', headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('POST /crm/api/chamados: exige cliente_id', async () => {
  const app = await build();
  const token = await tokenTenant();
  const res = await app.inject({ method: 'POST', url: '/crm/api/chamados', headers: { authorization: `Bearer ${token}` }, payload: { descricao: 'bug x' } });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /crm/api/chamados: exige descricao (validação de lib/chamados.js)', async () => {
  const app = await build();
  pool.query = async () => ({ rows: [{ id: 'cli-1' }] });
  const token = await tokenTenant();
  const res = await app.inject({
    method: 'POST', url: '/crm/api/chamados', headers: { authorization: `Bearer ${token}` },
    payload: { cliente_id: 'cli-1', descricao: '  ' },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('PATCH /crm/api/chamados/:id: status inválido devolve 400', async () => {
  const app = await build();
  const token = await tokenTenant();
  const res = await app.inject({
    method: 'PATCH', url: '/crm/api/chamados/ch-1', headers: { authorization: `Bearer ${token}` },
    payload: { status: 'status-que-nao-existe' },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('PATCH /crm/api/chamados/:id: resolver marca resolvido_em (query inclui o CASE)', async () => {
  const app = await build();
  let sqlCapturada;
  let paramsCapturados;
  pool.query = async (sql, params) => {
    sqlCapturada = sql;
    paramsCapturados = params;
    return { rows: [{ id: 'ch-1', status: 'resolvido' }] };
  };
  const token = await tokenTenant();
  const res = await app.inject({
    method: 'PATCH', url: '/crm/api/chamados/ch-1', headers: { authorization: `Bearer ${token}` },
    payload: { status: 'resolvido', resolucao_resumo: 'Corrigido no deploy X' },
  });
  assert.equal(res.statusCode, 200);
  assert.match(sqlCapturada, /resolvido_em = case when \$5 and resolvido_em is null then now\(\) else resolvido_em end/);
  assert.equal(paramsCapturados[4], true);
  await app.close();
});

test('todas as rotas de chamados exigem token', async () => {
  const app = await build();
  for (const [method, url] of [
    ['GET', '/crm/api/chamados'], ['POST', '/crm/api/chamados'], ['GET', '/crm/api/chamados/x'], ['PATCH', '/crm/api/chamados/x'],
  ]) {
    const res = await app.inject({ method, url });
    assert.equal(res.statusCode, 401, `${method} ${url}`);
  }
  await app.close();
});
