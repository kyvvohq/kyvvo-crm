const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.CRM_JWT_SECRET = process.env.CRM_JWT_SECRET || 'segredo-de-teste';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/none';

const { pool } = require('../lib/db');
const { build } = require('../index');

// GET /crm/api/clientes é consumido por duas formas: sem `pagina` (picker de
// cliente em quadro.html/campanhas.html, espera array simples — comportamento
// antigo, não pode quebrar) e com `pagina`/`tamanho` (tela de Clientes, padrão
// de listagem do DS — Fase 2 da padronização, espera { dados, total }).

async function tokenTenant(app) {
  return app.jwt.sign({ tenantId: 'tenant-1', userId: 'user-1', email: 'a@b.com', nome: 'Ana' });
}

afterEach(() => {
  delete pool.query;
});

test('sem `pagina`: devolve array simples (comportamento antigo, picker de cliente)', async () => {
  const app = await build();
  pool.query = async (sql, params) => {
    assert.match(sql, /limit 200/);
    assert.ok(!sql.includes('total_geral'), 'sem `pagina` não deve usar a query paginada');
    assert.deepEqual(params, ['tenant-1']);
    return { rows: [{ id: 'c1', nome: 'Maria' }, { id: 'c2', nome: 'João' }] };
  };
  const token = await tokenTenant(app);
  const res = await app.inject({ method: 'GET', url: '/crm/api/clientes', headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 200);
  const corpo = res.json();
  assert.ok(Array.isArray(corpo));
  assert.equal(corpo.length, 2);
  await app.close();
});

test('com `pagina`: devolve { dados, total }, com limit/offset corretos', async () => {
  const app = await build();
  let paramsRecebidos;
  pool.query = async (sql, params) => {
    assert.match(sql, /count\(\*\) over\(\)::int as total_geral/);
    assert.match(sql, /limit \$2 offset \$3/);
    paramsRecebidos = params;
    return {
      rows: [
        { id: 'c1', nome: 'Ana', total_geral: 37 },
        { id: 'c2', nome: 'Bia', total_geral: 37 },
      ],
    };
  };
  const token = await tokenTenant(app);
  const res = await app.inject({
    method: 'GET', url: '/crm/api/clientes?pagina=2&tamanho=25',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  const corpo = res.json();
  assert.equal(corpo.total, 37);
  assert.equal(corpo.dados.length, 2);
  assert.ok(!('total_geral' in corpo.dados[0]), 'total_geral não deve vazar pro cliente de cada linha');
  assert.deepEqual(paramsRecebidos, ['tenant-1', 25, 25]); // página 2, tamanho 25 -> offset 25
  await app.close();
});

test('`tamanho` é limitado a 100 (evita abuso) e mínimo 1', async () => {
  const app = await build();
  let paramsRecebidos;
  pool.query = async (sql, params) => {
    paramsRecebidos = params;
    return { rows: [] };
  };
  const token = await tokenTenant(app);
  await app.inject({
    method: 'GET', url: '/crm/api/clientes?pagina=1&tamanho=9999',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(paramsRecebidos[1], 100);
  await app.close();
});

test('com `pagina` e sem resultado: total = 0, dados = []', async () => {
  const app = await build();
  pool.query = async () => ({ rows: [] });
  const token = await tokenTenant(app);
  const res = await app.inject({
    method: 'GET', url: '/crm/api/clientes?pagina=1',
    headers: { authorization: `Bearer ${token}` },
  });
  const corpo = res.json();
  assert.equal(corpo.total, 0);
  assert.deepEqual(corpo.dados, []);
  await app.close();
});
