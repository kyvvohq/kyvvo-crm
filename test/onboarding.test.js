const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tenantPrecisaOnboarding, confirmarOnboarding } = require('../lib/onboarding');

function poolFalso() {
  const linhas = new Map();
  return {
    query: async (sql, params) => {
      if (/^insert into crm_onboarding \(tenant_id\) values/.test(sql)) {
        const [tenantId] = params;
        if (linhas.has(tenantId)) return { rows: [] }; // ON CONFLICT DO NOTHING
        linhas.set(tenantId, { confirmado_em: null });
        return { rows: [{ confirmado_em: null }] };
      }
      if (/^select confirmado_em from crm_onboarding/.test(sql)) {
        const [tenantId] = params;
        return { rows: linhas.has(tenantId) ? [linhas.get(tenantId)] : [] };
      }
      if (/^insert into crm_onboarding \(tenant_id, confirmado_em\)/.test(sql)) {
        const [tenantId] = params;
        linhas.set(tenantId, { confirmado_em: new Date() });
        return { rows: [] };
      }
      throw new Error('query inesperada: ' + sql);
    },
  };
}

test('tenantPrecisaOnboarding: conta nova (primeira chamada) retorna true', async () => {
  const pool = poolFalso();
  assert.equal(await tenantPrecisaOnboarding(pool, 'tenant-a'), true);
});

test('tenantPrecisaOnboarding: chamar de novo sem confirmar continua true', async () => {
  const pool = poolFalso();
  await tenantPrecisaOnboarding(pool, 'tenant-a');
  assert.equal(await tenantPrecisaOnboarding(pool, 'tenant-a'), true);
});

test('confirmarOnboarding: depois de confirmar, tenantPrecisaOnboarding vira false', async () => {
  const pool = poolFalso();
  await tenantPrecisaOnboarding(pool, 'tenant-a');
  await confirmarOnboarding(pool, 'tenant-a');
  assert.equal(await tenantPrecisaOnboarding(pool, 'tenant-a'), false);
});
