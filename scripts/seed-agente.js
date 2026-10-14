// Uso (PowerShell):
//   node scripts/seed-agente.js --tenant <uuid> [--seed db/seeds/basic.json]
//        [--modo desligado|rascunho|automatico] [--phone-number-id <id>]
//        [--numero "+55 34 95330-1392"] [--canal-modo api|coexistencia]
// Sem --modo, preserva o modo já em uso na conta (não desliga o bot ao
// reaplicar config/conhecimento novos) — só assume 'desligado' na primeira
// vez. Precisa de DATABASE_URL. O número da conta entra por argumento, nunca por código.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../lib/db');
const { semearAgente } = require('../lib/agente/seed');

function args() {
  const out = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 2) out[a[i].replace(/^--/, '')] = a[i + 1];
  return out;
}

(async () => {
  const o = args();
  if (!o.tenant) throw new Error('--tenant obrigatório');
  const arquivo = path.resolve(o.seed || path.join(__dirname, '..', 'db', 'seeds', 'basic.json'));
  const seed = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  const conhecimento = {};
  for (const [tipo, rel] of Object.entries(seed.conhecimento || {})) {
    conhecimento[tipo] = fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
  }
  // Sem --modo, preserva o modo já em uso em vez de assumir 'desligado' —
  // reaplicar o seed (config/conhecimento novos) numa conta já em produção
  // não pode desligar o bot sem querer. Só cai em 'desligado' na primeira
  // vez (conta ainda sem linha em crm_agente_config).
  let modo = o.modo;
  if (!modo) {
    const { rows } = await pool.query('select modo from crm_agente_config where tenant_id = $1', [o.tenant]);
    modo = rows[0] ? rows[0].modo : 'desligado';
  }
  await semearAgente(pool, o.tenant, seed, {
    conhecimento,
    modo,
    phoneNumberId: o['phone-number-id'] || null,
    numeroExibido: o.numero || null,
    canalModo: o['canal-modo'] || 'api',
  });
  console.log(`seed aplicado: tenant ${o.tenant} (${path.basename(arquivo)})`);
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
