// Uso (PowerShell):
//   node scripts/seed-leads-chamados.js --tenant <uuid>
// Inicializa o funil padrão de Leads (Novo lead/Qualificando/Proposta
// enviada/Ganho/Perdido) pra uma conta — idempotente, não faz nada se a
// conta já tiver etapas de lead. Chamados não precisa de inicialização (é
// só um status fixo, sem etapas configuráveis). Precisa de DATABASE_URL.
require('dotenv').config();
const { pool } = require('../lib/db');
const { inicializarEtapasLeads } = require('../lib/leads');

function args() {
  const out = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 2) out[a[i].replace(/^--/, '')] = a[i + 1];
  return out;
}

(async () => {
  const o = args();
  if (!o.tenant) throw new Error('--tenant obrigatório');
  await inicializarEtapasLeads(pool, o.tenant);
  console.log(`etapas de lead inicializadas pro tenant ${o.tenant}`);
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
