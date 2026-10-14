// Observabilidade do agente por conta. Wrapper fininho de
// @kyvvohq/agente-core (fase 1 de padronizar o Atendimento entre produtos
// Kyvvo, 2026-10-14) — a lógica de cálculo é genérica e vive no pacote;
// resolver o nome da cliente (join com crm_clientes) é decisão do CRM.
const agenteCore = require('./nucleo');

// Não exportado pelo pacote (uso interno dele); mantido aqui só por
// compatibilidade com quem importava esta constante deste módulo — nenhum
// consumidor real encontrado no repo.
const LIMITE_ALERTA_TETO = 0.8;

async function resolverNomesClientes(pool, tenantId, clienteIds) {
  if (!clienteIds.length) return new Map();
  const { rows } = await pool.query('select id, nome from crm_clientes where tenant_id = $1 and id = any($2::uuid[])', [tenantId, clienteIds]);
  return new Map(rows.map((r) => [r.id, r.nome]));
}

function calcular(pool, tenantId, opts = {}) {
  return agenteCore.calcularMetricas(pool, tenantId, { ...opts, resolverNomesClientes });
}

module.exports = { calcular, LIMITE_ALERTA_TETO };
