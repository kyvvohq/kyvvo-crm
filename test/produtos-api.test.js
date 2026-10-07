const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.CRM_JWT_SECRET = process.env.CRM_JWT_SECRET || 'segredo-de-teste';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/none';

const { pool } = require('../lib/db');
const { build } = require('../index');

// Mesmo contrato de /crm/api/clientes: sem `pagina` devolve array simples
// (picker de produto em quadro.html/pedidos.html/campanhas.html), com
// `pagina` devolve { dados, total } (tela de Estoque, padrão de listagem do DS).

async function tokenTenant(app) {
  return app.jwt.sign({ tenantId: 'tenant-1', userId: 'user-1', email: 'a@b.com', nome: 'Ana' });
}

afterEach(() => {
  delete pool.query;
});

test('sem `pagina`: devolve array simples (comportamento antigo, picker de produto)', async () => {
  const app = await build();
  pool.query = async (sql, params) => {
    assert.ok(!sql.includes('total_geral'), 'sem `pagina` não deve usar a query paginada');
    assert.deepEqual(params, ['tenant-1']);
    return { rows: [{ id: 'p1', nome: 'Vaso' }] };
  };
  const token = await tokenTenant(app);
  const res = await app.inject({ method: 'GET', url: '/crm/api/produtos', headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 200);
  const corpo = res.json();
  assert.ok(Array.isArray(corpo));
  assert.equal(corpo.length, 1);
  await app.close();
});

test('com `pagina`: devolve { dados, total }, com limit/offset e busca corretos', async () => {
  const app = await build();
  let paramsRecebidos;
  pool.query = async (sql, params) => {
    assert.match(sql, /count\(\*\) over\(\)::int as total_geral/);
    assert.match(sql, /lower\(nome\) like \$2 or lower\(identificador_externo\) like \$2 or lower\(observacao\) like \$2/);
    assert.match(sql, /limit \$3 offset \$4/);
    paramsRecebidos = params;
    return {
      rows: [
        { id: 'p1', nome: 'Vaso decorativo', total_geral: 12 },
        { id: 'p2', nome: 'Vaso pequeno', total_geral: 12 },
      ],
    };
  };
  const token = await tokenTenant(app);
  const res = await app.inject({
    method: 'GET', url: '/crm/api/produtos?pagina=1&tamanho=25&busca=Vaso',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  const corpo = res.json();
  assert.equal(corpo.total, 12);
  assert.equal(corpo.dados.length, 2);
  assert.ok(!('total_geral' in corpo.dados[0]));
  assert.deepEqual(paramsRecebidos, ['tenant-1', '%vaso%', 25, 0]);
  await app.close();
});
