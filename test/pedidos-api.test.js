const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.CRM_JWT_SECRET = process.env.CRM_JWT_SECRET || 'segredo-de-teste';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/none';

const { pool } = require('../lib/db');
const { build } = require('../index');

// Mesmo contrato de /crm/api/clientes e /crm/api/produtos: sem `pagina`
// devolve array simples (quadro.html precisa do board inteiro de uma vez),
// com `pagina` devolve { dados, total } (tela de Pedidos, padrão de
// listagem do DS) — e os filtros existentes (etapa/recurso/pagamento/
// prioridade/período) continuam funcionando junto com a paginação e a
// busca nova por nome de cliente.

async function tokenTenant(app) {
  return app.jwt.sign({ tenantId: 'tenant-1', userId: 'user-1', email: 'a@b.com', nome: 'Ana' });
}

afterEach(() => {
  delete pool.query;
});

test('sem `pagina`: devolve array simples (comportamento antigo, usado pelo Quadro)', async () => {
  const app = await build();
  pool.query = async (sql, params) => {
    assert.ok(!sql.includes('total_geral'), 'sem `pagina` não deve usar a query paginada');
    assert.deepEqual(params, ['tenant-1']);
    return { rows: [{ id: 'ped1', cliente_nome: 'Ana' }] };
  };
  const token = await tokenTenant(app);
  const res = await app.inject({ method: 'GET', url: '/crm/api/pedidos', headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 200);
  const corpo = res.json();
  assert.ok(Array.isArray(corpo));
  assert.equal(corpo.length, 1);
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
        { id: 'ped1', cliente_nome: 'Ana', total_geral: 5 },
        { id: 'ped2', cliente_nome: 'Bia', total_geral: 5 },
      ],
    };
  };
  const token = await tokenTenant(app);
  const res = await app.inject({
    method: 'GET', url: '/crm/api/pedidos?pagina=1&tamanho=25',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  const corpo = res.json();
  assert.equal(corpo.total, 5);
  assert.equal(corpo.dados.length, 2);
  assert.ok(!('total_geral' in corpo.dados[0]));
  assert.deepEqual(paramsRecebidos, ['tenant-1', 25, 0]);
  await app.close();
});

test('com `pagina` e filtros existentes + busca por cliente: todos combinam na mesma query', async () => {
  const app = await build();
  let sqlRecebido;
  let paramsRecebidos;
  pool.query = async (sql, params) => {
    sqlRecebido = sql;
    paramsRecebidos = params;
    return { rows: [] };
  };
  const token = await tokenTenant(app);
  await app.inject({
    method: 'GET',
    url: '/crm/api/pedidos?pagina=2&tamanho=10&etapa_id=et1&status_pagamento=pago&busca=Maria',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.match(sqlRecebido, /p\.etapa_id = \$2/);
  assert.match(sqlRecebido, /p\.status_pagamento = \$3/);
  assert.match(sqlRecebido, /lower\(c\.nome\) like \$4/);
  assert.deepEqual(paramsRecebidos, ['tenant-1', 'et1', 'pago', '%maria%', 10, 10]); // página 2, tamanho 10 -> offset 10
  await app.close();
});

test('GET /crm/api/pedidos/:id: devolve o pedido específico (link direto do Painel Hoje)', async () => {
  const app = await build();
  pool.query = async (sql, params) => {
    assert.match(sql, /where p\.id = \$1 and p\.tenant_id = \$2/);
    assert.deepEqual(params, ['ped-xyz', 'tenant-1']);
    return { rows: [{ id: 'ped-xyz', cliente_nome: 'Ana' }] };
  };
  const token = await tokenTenant(app);
  const res = await app.inject({ method: 'GET', url: '/crm/api/pedidos/ped-xyz', headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().id, 'ped-xyz');
  await app.close();
});

test('GET /crm/api/pedidos/:id: 404 quando não encontrado', async () => {
  const app = await build();
  pool.query = async () => ({ rows: [] });
  const token = await tokenTenant(app);
  const res = await app.inject({ method: 'GET', url: '/crm/api/pedidos/nao-existe', headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 404);
  await app.close();
});
