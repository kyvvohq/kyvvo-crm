const { test } = require('node:test');
const assert = require('node:assert/strict');
const { listarHistoricoNotificacoes } = require('../lib/notificacoes');

test('listarHistoricoNotificacoes: pagina por padrão (1, tamanho 25), devolve { historico, total }', async () => {
  let paramsRecebidos;
  const pool = {
    query: async (sql, params) => {
      assert.match(sql, /count\(\*\) over\(\)::int as total_geral/);
      assert.match(sql, /limit \$2 offset \$3/);
      paramsRecebidos = params;
      return { rows: [{ id: 'n1', chave: 'pedido_criado', titulo: 'x', detalhe: null, criado_em: new Date(), lida: false, lida_em: null, total_geral: 40 }] };
    },
  };
  const resultado = await listarHistoricoNotificacoes(pool, 'tenant-1');
  assert.deepEqual(paramsRecebidos, ['tenant-1', 25, 0]);
  assert.equal(resultado.total, 40);
  assert.equal(resultado.historico.length, 1);
  assert.ok(!('total_geral' in resultado.historico[0]));
  assert.equal(resultado.historico[0].tipoTitulo, 'Novo pedido criado');
});

test('listarHistoricoNotificacoes: página/tamanho explícitos viram offset certo, tamanho tem teto de 100', async () => {
  let paramsRecebidos;
  const pool = {
    query: async (sql, params) => { paramsRecebidos = params; return { rows: [] }; },
  };
  await listarHistoricoNotificacoes(pool, 'tenant-1', { pagina: 3, tamanho: 9999 });
  assert.deepEqual(paramsRecebidos, ['tenant-1', 100, 200]); // página 3, tamanho 100 -> offset 200
});

test('listarHistoricoNotificacoes: sem resultado devolve total 0 e historico vazio', async () => {
  const pool = { query: async () => ({ rows: [] }) };
  const resultado = await listarHistoricoNotificacoes(pool, 'tenant-1');
  assert.equal(resultado.total, 0);
  assert.deepEqual(resultado.historico, []);
});
