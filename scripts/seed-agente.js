// Uso (PowerShell):
//   node scripts/seed-agente.js --tenant <uuid> [--seed db/seeds/basic.json]
//        [--modo desligado|rascunho|automatico] [--phone-number-id <id>]
//        [--numero "+55 34 95330-1392"] [--canal-modo api|coexistencia]
// Precisa de DATABASE_URL. O número da conta entra por argumento, nunca por código.
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
  await semearAgente(pool, o.tenant, seed, {
    modo: o.modo || 'desligado',
    phoneNumberId: o['phone-number-id'] || null,
    numeroExibido: o.numero || null,
    canalModo: o['canal-modo'] || 'api',
  });
  console.log(`seed aplicado: tenant ${o.tenant} (${path.basename(arquivo)})`);
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
