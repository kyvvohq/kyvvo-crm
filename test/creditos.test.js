const { test } = require('node:test');
const assert = require('node:assert/strict');
const { obterSaldo, debitar, creditarCompra } = require('../lib/creditos');

// Fixture mínima — já "renovado" neste mês (ciclo_renovado_em = agora), pra
// não precisar mockar o fetch() pro platform (buscarPlanoTenant). Mesmo
// padrão de test/automacoes.test.js.
function poolFalso({ saldoPlano = 0, saldoComprado = 0 } = {}) {
  const estado = { saldoPlano, saldoComprado, renovadoEm: new Date() };
  return {
    estado,
    query: async (sql, params) => {
      if (/^select ciclo_renovado_em from crm_creditos/.test(sql)) {
        return { rows: estado.renovadoEm ? [{ ciclo_renovado_em: estado.renovadoEm }] : [] };
      }
      if (/^select saldo_plano, saldo_comprado from crm_creditos/.test(sql)) {
        return { rows: [{ saldo_plano: estado.saldoPlano, saldo_comprado: estado.saldoComprado }] };
      }
      if (/^update crm_creditos set/.test(sql)) {
        if (estado.saldoPlano > 0) estado.saldoPlano -= 1;
        else if (estado.saldoComprado > 0) estado.saldoComprado -= 1;
        else return { rows: [] };
        return { rows: [{ saldo_plano: estado.saldoPlano, saldo_comprado: estado.saldoComprado }] };
      }
      if (/^insert into crm_creditos \(tenant_id, saldo_comprado\)/.test(sql)) {
        estado.saldoComprado += params[1];
        return { rows: [{ saldo_plano: estado.saldoPlano, saldo_comprado: estado.saldoComprado }] };
      }
      throw new Error('query inesperada: ' + sql);
    },
  };
}

test('debitar: consome saldo_plano primeiro, só cai no comprado quando a cota zera', async () => {
  const pool = poolFalso({ saldoPlano: 1, saldoComprado: 2 });
  assert.equal(await debitar(pool, 't1'), true);
  assert.deepEqual(pool.estado, { saldoPlano: 0, saldoComprado: 2, renovadoEm: pool.estado.renovadoEm });
  assert.equal(await debitar(pool, 't1'), true);
  assert.equal(pool.estado.saldoComprado, 1);
});

test('debitar: sem saldo nenhum, devolve false e não mexe em nada', async () => {
  const pool = poolFalso({ saldoPlano: 0, saldoComprado: 0 });
  assert.equal(await debitar(pool, 't1'), false);
  assert.equal(pool.estado.saldoPlano, 0);
  assert.equal(pool.estado.saldoComprado, 0);
});

test('obterSaldo: soma plano + comprado em saldoTotal', async () => {
  const pool = poolFalso({ saldoPlano: 3, saldoComprado: 5 });
  assert.deepEqual(await obterSaldo(pool, 't1'), { saldoPlano: 3, saldoComprado: 5, saldoTotal: 8 });
});

test('creditarCompra: soma no saldo_comprado, nunca mexe no saldo_plano', async () => {
  const pool = poolFalso({ saldoPlano: 10, saldoComprado: 0 });
  const resultado = await creditarCompra(pool, 't1', 300);
  assert.equal(resultado.saldo_comprado, 300);
  assert.equal(pool.estado.saldoPlano, 10);
});
