// Smoke test real: sobe o app Fastify contra o Postgres do CI (gate.yml
// aplica as migrations antes), sem mocks. Cobre só o que não depende do
// kyvvo-platform estar no ar (login/acesso ficam fora daqui).
const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.CRM_JWT_SECRET = process.env.CRM_JWT_SECRET || 'segredo-de-teste';

const { build } = require('../index');

test('GET /crm/api/saude responde ok', async () => {
  const app = await build();
  const res = await app.inject({ method: 'GET', url: '/crm/api/saude' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
  await app.close();
});

test('rotas autenticadas exigem token', async () => {
  const app = await build();
  const res = await app.inject({ method: 'GET', url: '/crm/api/clientes' });
  assert.equal(res.statusCode, 401);
  await app.close();
});
