const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { encontrarOuCriarPorTelefone, garantirOpcaoOrigem } = require('../lib/clientes');

describe('encontrarOuCriarPorTelefone: corrige nome placeholder (bug real, 2026-10-02)', () => {
  test('cliente já existe com "Sem nome" + nome de verdade chega agora: atualiza', async () => {
    const cliente = { id: 'cliente-1', tenant_id: 't1', telefone: '+5534999998888', nome: 'Sem nome' };
    const queries = [];
    const pool = {
      query: async (sql, params) => {
        queries.push(sql);
        if (/^select \* from crm_clientes/.test(sql)) return { rows: [cliente] };
        if (/^update crm_clientes set nome/.test(sql)) {
          assert.deepEqual(params, ['Maria Silva', 'cliente-1']);
          return { rows: [{ ...cliente, nome: 'Maria Silva' }] };
        }
        throw new Error('query inesperada: ' + sql);
      },
    };
    const resultado = await encontrarOuCriarPorTelefone(pool, 't1', { telefone: '+5534999998888', nome: 'Maria Silva' });
    assert.equal(resultado.nome, 'Maria Silva');
    assert.ok(queries.some((s) => /^update crm_clientes set nome/.test(s)));
  });

  test('cliente já existe com nome de verdade: NÃO sobrescreve', async () => {
    const cliente = { id: 'cliente-1', tenant_id: 't1', telefone: '+5534999998888', nome: 'João Pereira' };
    const pool = {
      query: async (sql) => {
        if (/^select \* from crm_clientes/.test(sql)) return { rows: [cliente] };
        throw new Error('query inesperada (não devia atualizar): ' + sql);
      },
    };
    const resultado = await encontrarOuCriarPorTelefone(pool, 't1', { telefone: '+5534999998888', nome: 'Outro Nome Vindo Do Whats' });
    assert.equal(resultado.nome, 'João Pereira');
  });

  test('cliente novo: cria normalmente', async () => {
    const pool = {
      query: async (sql) => {
        if (/^select \* from crm_clientes/.test(sql)) return { rows: [] };
        if (/^insert into crm_clientes/.test(sql)) return { rows: [{ id: 'cliente-novo', nome: 'Ana' }] };
        throw new Error('query inesperada: ' + sql);
      },
    };
    const resultado = await encontrarOuCriarPorTelefone(pool, 't1', { telefone: '+5534999997777', nome: 'Ana' });
    assert.equal(resultado.id, 'cliente-novo');
  });
});

describe('garantirOpcaoOrigem', () => {
  test('faz upsert silencioso (on conflict do nothing) em crm_opcoes_cadastro', async () => {
    let chamado = null;
    const pool = { query: async (sql, params) => { chamado = { sql, params }; return { rows: [] }; } };
    await garantirOpcaoOrigem(pool, 't1', 'Importação');
    assert.match(chamado.sql, /on conflict \(tenant_id, tipo, lower\(valor\)\) do nothing/);
    assert.deepEqual(chamado.params, ['t1', 'Importação']);
  });
});
