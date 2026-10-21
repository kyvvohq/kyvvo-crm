// Smoke test real: sobe o app Fastify contra o Postgres do CI (gate.yml
// aplica as migrations antes), sem mocks. Cobre só o que não depende do
// kyvvo-platform estar no ar (login/acesso ficam fora daqui).
const { test } = require('node:test');
const assert = require('node:assert/strict');

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

test('rotas novas de prioridade/cancelamento de pedido também exigem token', async () => {
  const app = await build();
  const prioridade = await app.inject({ method: 'PATCH', url: '/crm/api/pedidos/qualquer-id/prioridade', payload: { prioridade: 'altissima' } });
  assert.equal(prioridade.statusCode, 401);
  const cancelar = await app.inject({ method: 'POST', url: '/crm/api/pedidos/qualquer-id/cancelar', payload: { motivo: 'teste' } });
  assert.equal(cancelar.statusCode, 401);
  await app.close();
});

test('rota nova de valor do pedido também exige token', async () => {
  const app = await build();
  const res = await app.inject({ method: 'PATCH', url: '/crm/api/pedidos/qualquer-id/valor', payload: { valor_total: 50 } });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('rotas de créditos (Automações > Consumo e Comprar créditos) também exigem token', async () => {
  const app = await build();
  const consumo = await app.inject({ method: 'GET', url: '/crm/api/automacoes/consumo' });
  assert.equal(consumo.statusCode, 401);
  const pacotes = await app.inject({ method: 'GET', url: '/crm/api/automacoes/creditos/pacotes' });
  assert.equal(pacotes.statusCode, 401);
  const comprar = await app.inject({ method: 'POST', url: '/crm/api/automacoes/creditos/comprar', payload: { pacote: 'creditos_100', meio: 'pix' } });
  assert.equal(comprar.statusCode, 401);
  await app.close();
});

test('disparo individual de aniversário (modelo aprovado) exige token', async () => {
  const app = await build();
  const res = await app.inject({ method: 'POST', url: '/crm/api/clientes/qualquer-id/whatsapp-aniversario', payload: { templateNome: 'x' } });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('plataforma-interno de créditos: exige CRM_CREDITOS_INTERNAL_TOKEN, não JWT', async () => {
  const app = await build();
  const semToken = await app.inject({ method: 'POST', url: '/crm/plataforma-interno/creditos/confirmar', payload: { tenantId: 'x', quantidade: 100 } });
  assert.equal(semToken.statusCode, 401);

  process.env.CRM_CREDITOS_INTERNAL_TOKEN = 'segredo-plataforma-interno-teste';
  const tokenErrado = await app.inject({
    method: 'POST', url: '/crm/plataforma-interno/creditos/confirmar',
    headers: { 'x-internal-token': 'errado' }, payload: { tenantId: 'x', quantidade: 100 },
  });
  assert.equal(tokenErrado.statusCode, 401);
  delete process.env.CRM_CREDITOS_INTERNAL_TOKEN;
  await app.close();
});

test('admin-interno de whatsapp-numeros: exige ADMIN_INTERNAL_TOKEN, não JWT', async () => {
  const app = await build();
  const semToken = await app.inject({ method: 'GET', url: '/crm/admin-interno/whatsapp-numeros' });
  assert.equal(semToken.statusCode, 401);

  process.env.ADMIN_INTERNAL_TOKEN = 'segredo-admin-interno-teste';
  const tokenErrado = await app.inject({
    method: 'GET', url: '/crm/admin-interno/whatsapp-numeros', headers: { 'x-admin-internal-token': 'errado' },
  });
  assert.equal(tokenErrado.statusCode, 401);
  delete process.env.ADMIN_INTERNAL_TOKEN;
  await app.close();
});

test('admin-interno de agente/metricas: exige ADMIN_INTERNAL_TOKEN, não JWT', async () => {
  const app = await build();
  const semToken = await app.inject({ method: 'GET', url: '/crm/admin-interno/agente/metricas/00000000-0000-0000-0000-000000000000' });
  assert.equal(semToken.statusCode, 401);
  await app.close();
});

test('admin-interno de whatsapp-numeros: vincular, trocar tenant e desvincular', async () => {
  process.env.ADMIN_INTERNAL_TOKEN = 'segredo-admin-interno-teste';
  const app = await build();
  const headers = { 'x-admin-internal-token': 'segredo-admin-interno-teste' };
  const phoneNumberId = `teste-${Date.now()}`;
  const tenantA = '11111111-1111-1111-1111-111111111111';
  const tenantB = '22222222-2222-2222-2222-222222222222';

  const criar = await app.inject({
    method: 'POST', url: '/crm/admin-interno/whatsapp-numeros', headers,
    payload: { phone_number_id: phoneNumberId, tenant_id: tenantA, numero_exibido: '+55 34 90000-0000' },
  });
  assert.equal(criar.statusCode, 201);
  assert.equal(criar.json().tenant_id, tenantA);

  // "alterar": mesmo phone_number_id, tenant diferente — upsert, não duplica linha.
  const trocar = await app.inject({
    method: 'POST', url: '/crm/admin-interno/whatsapp-numeros', headers,
    payload: { phone_number_id: phoneNumberId, tenant_id: tenantB },
  });
  assert.equal(trocar.statusCode, 201);
  assert.equal(trocar.json().tenant_id, tenantB);
  assert.equal(trocar.json().numero_exibido, '+55 34 90000-0000'); // preservado, não veio no body

  const listar = await app.inject({ method: 'GET', url: '/crm/admin-interno/whatsapp-numeros', headers });
  assert.equal(listar.statusCode, 200);
  assert.ok(listar.json().numeros.some((n) => n.phone_number_id === phoneNumberId && n.tenant_id === tenantB));

  const apagar = await app.inject({ method: 'DELETE', url: `/crm/admin-interno/whatsapp-numeros/${phoneNumberId}`, headers });
  assert.equal(apagar.statusCode, 200);
  const listarDepois = await app.inject({ method: 'GET', url: '/crm/admin-interno/whatsapp-numeros', headers });
  assert.ok(!listarDepois.json().numeros.some((n) => n.phone_number_id === phoneNumberId));

  delete process.env.ADMIN_INTERNAL_TOKEN;
  await app.close();
});
