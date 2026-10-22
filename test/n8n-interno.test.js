const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/none';
process.env.N8N_INTERNAL_TOKEN = 'segredo-n8n-interno-teste';

const { pool } = require('../lib/db');
const { build } = require('../index');

const headers = { 'x-n8n-internal-token': 'segredo-n8n-interno-teste' };

afterEach(() => { delete pool.query; });

test('POST /crm/n8n-interno/clientes: acha-ou-cria por telefone, devolve id/nome', async () => {
  const app = await build();
  pool.query = async (sql) => {
    if (/^select \* from crm_clientes/.test(sql)) return { rows: [] };
    if (/^insert into crm_clientes/.test(sql)) return { rows: [{ id: 'cli-1', nome: 'Joana' }] };
    throw new Error('query inesperada: ' + sql);
  };
  const res = await app.inject({
    method: 'POST', url: '/crm/n8n-interno/clientes', headers,
    payload: { tenant_id: 'tenant-1', telefone: '+5534999990000', nome: 'Joana' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { id: 'cli-1', nome: 'Joana' });
  await app.close();
});

test('GET /crm/n8n-interno/historico: devolve mensagens em ordem cronológica (mais antiga primeiro)', async () => {
  const app = await build();
  let paramsCapturados;
  pool.query = async (sql, params) => {
    paramsCapturados = params;
    return { rows: [{ direcao: 'enviada', conteudo: 'Oi!' }, { direcao: 'recebida', conteudo: 'Oi, tudo bem?' }] }; // vem DESC do banco
  };
  const res = await app.inject({
    method: 'GET', url: '/crm/n8n-interno/historico?tenant_id=tenant-1&telefone=%2B5534999990000&limite=10', headers,
  });
  assert.equal(res.statusCode, 200);
  const corpo = res.json();
  assert.equal(corpo.mensagens[0].conteudo, 'Oi, tudo bem?'); // revertido: mais antiga primeiro
  assert.equal(corpo.mensagens[1].conteudo, 'Oi!');
  assert.deepEqual(paramsCapturados, ['tenant-1', '+5534999990000', 10]);
  await app.close();
});

test('POST /crm/n8n-interno/mensagens: grava recebida e enviada', async () => {
  const app = await build();
  const inserts = [];
  pool.query = async (sql, params) => {
    if (/^insert into crm_mensagens_whatsapp/.test(sql)) { inserts.push(params); return { rows: [] }; }
    throw new Error('query inesperada: ' + sql);
  };
  const res = await app.inject({
    method: 'POST', url: '/crm/n8n-interno/mensagens', headers,
    payload: { tenant_id: 'tenant-1', telefone: '+5534999990000', texto_recebido: 'Oi', texto_enviado: 'Olá!' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(inserts.length, 2);
  await app.close();
});

test('POST /crm/n8n-interno/leads: garante lead aberto e atualiza campos', async () => {
  const app = await build();
  pool.query = async (sql, params) => {
    if (/^select l\.\* from crm_leads/.test(sql)) return { rows: [] };
    if (/^select id from crm_leads_etapas/.test(sql)) return { rows: [{ id: 'etapa-1' }] };
    if (/^insert into crm_leads/.test(sql)) return { rows: [{ id: 'lead-1', tenant_id: 'tenant-1', cliente_id: 'cli-1', etapa_id: 'etapa-1' }] };
    if (/^update crm_leads set/.test(sql)) return { rows: [{ id: 'lead-1', empresa: 'Salão da Joana', produto_interesse: 'studio' }] };
    throw new Error('query inesperada: ' + sql);
  };
  const res = await app.inject({
    method: 'POST', url: '/crm/n8n-interno/leads', headers,
    payload: { tenant_id: 'tenant-1', cliente_id: 'cli-1', empresa: 'Salão da Joana', produto_interesse: 'studio' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().empresa, 'Salão da Joana');
  await app.close();
});

test('POST /crm/n8n-interno/chamados: cria chamado, exige descricao', async () => {
  const app = await build();
  pool.query = async (sql) => {
    if (/^insert into crm_chamados/.test(sql)) return { rows: [{ id: 'ch-1', categoria: 'bug', status: 'aberto' }] };
    throw new Error('query inesperada: ' + sql);
  };
  const semDescricao = await app.inject({
    method: 'POST', url: '/crm/n8n-interno/chamados', headers,
    payload: { tenant_id: 'tenant-1', cliente_id: 'cli-1', categoria: 'bug' },
  });
  assert.equal(semDescricao.statusCode, 400);

  const ok = await app.inject({
    method: 'POST', url: '/crm/n8n-interno/chamados', headers,
    payload: { tenant_id: 'tenant-1', cliente_id: 'cli-1', categoria: 'bug', descricao: 'Erro ao mover etapa' },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().status, 'aberto');
  await app.close();
});
