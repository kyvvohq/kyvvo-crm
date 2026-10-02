const { test } = require('node:test');
const assert = require('node:assert/strict');
const { relatorioPedidos, AGRUPAMENTOS } = require('../lib/relatorios');

test('AGRUPAMENTOS: tem as 5 chaves esperadas (dia/cliente/tipo_entrega/segmento/origem)', () => {
  assert.deepEqual(Object.keys(AGRUPAMENTOS).sort(), ['cliente', 'dia', 'origem', 'segmento', 'tipo_entrega'].sort());
});

test('relatorioPedidos: sem agrupar_por, só consulta o resumo (1 query) e detalhado fica vazio', async () => {
  let chamadas = 0;
  const pool = {
    query: async (sql) => {
      chamadas++;
      assert.match(sql, /count\(\*\)::int as quantidade/);
      assert.match(sql, /e\.tipo != 'perdida'/);
      return { rows: [{ quantidade: 3, valor_total: '150.00', valor_recebido: '100.00', frete_total: '20.00' }] };
    },
  };
  const resultado = await relatorioPedidos(pool, 'tenant-1', {});
  assert.equal(chamadas, 1);
  assert.equal(resultado.resumo.quantidade, 3);
  assert.equal(resultado.resumo.ticket_medio, 50);
  assert.deepEqual(resultado.detalhado, []);
  assert.equal(resultado.agrupar_por, null);
});

test('relatorioPedidos: com agrupar_por, faz as 2 queries (resumo + detalhado) com a coluna certa', async () => {
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push(sql);
      if (queries.length === 1) return { rows: [{ quantidade: 2, valor_total: '300.00', valor_recebido: '300.00', frete_total: '0' }] };
      assert.match(sql, /group by coalesce\(p\.tipo_entrega, 'Não informado'\)/);
      return { rows: [{ chave: 'Uber', rotulo: 'Uber', quantidade: 2, valor_total: '300.00' }] };
    },
  };
  const resultado = await relatorioPedidos(pool, 'tenant-1', { agruparPor: 'tipo_entrega' });
  assert.equal(queries.length, 2);
  assert.equal(resultado.agrupar_por, 'tipo_entrega');
  assert.equal(resultado.detalhado[0].rotulo, 'Uber');
});

test('relatorioPedidos: filtros viram condições com os params na ordem certa', async () => {
  let sqlCapturado, paramsCapturados;
  const pool = {
    query: async (sql, params) => {
      sqlCapturado = sql;
      paramsCapturados = params;
      return { rows: [{ quantidade: 0, valor_total: '0', valor_recebido: '0', frete_total: '0' }] };
    },
  };
  await relatorioPedidos(pool, 'tenant-1', { dataInicio: '2026-01-01', dataFim: '2026-01-31', tipoEntrega: 'Correios', segmento: 'Varejo', origem: 'site' });
  assert.match(sqlCapturado, /p\.criado_em >= \$2::date/);
  assert.match(sqlCapturado, /p\.criado_em < \$3::date \+ interval '1 day'/);
  assert.match(sqlCapturado, /p\.tipo_entrega = \$4/);
  assert.match(sqlCapturado, /c\.segmento = \$5/);
  assert.match(sqlCapturado, /p\.origem = \$6/);
  assert.deepEqual(paramsCapturados, ['tenant-1', '2026-01-01', '2026-01-31', 'Correios', 'Varejo', 'site']);
});
