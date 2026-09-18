// US26: onboarding em si (inicializarEtapasPadrao) continua automático e
// roda antes disto — este módulo só controla se a tela de revisão já foi
// vista/confirmada, pra decidir se o front redireciona pra ela no login.
async function tenantPrecisaOnboarding(pool, tenantId) {
  const { rows } = await pool.query(
    `insert into crm_onboarding (tenant_id) values ($1) on conflict (tenant_id) do nothing
     returning confirmado_em`,
    [tenantId]
  );
  if (rows[0]) return true; // linha acabou de ser criada agora: conta nova, nunca confirmou
  const { rows: existente } = await pool.query('select confirmado_em from crm_onboarding where tenant_id = $1', [tenantId]);
  return !existente[0] || existente[0].confirmado_em === null;
}

async function confirmarOnboarding(pool, tenantId) {
  await pool.query(
    `insert into crm_onboarding (tenant_id, confirmado_em) values ($1, now())
     on conflict (tenant_id) do update set confirmado_em = now()`,
    [tenantId]
  );
}

module.exports = { tenantPrecisaOnboarding, confirmarOnboarding };
