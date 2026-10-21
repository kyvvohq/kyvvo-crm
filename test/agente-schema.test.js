const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Banco real (mesmo critério do smoke.test.js): sem DATABASE_URL, pula.
const temBanco = !!process.env.DATABASE_URL;
const opts = temBanco ? {} : { skip: 'sem DATABASE_URL' };

const { pool, migrar } = require('../lib/db');
const { semearAgente } = require('../lib/agente/seed');
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'db', 'seeds', 'basic.json'), 'utf8'));

const A = crypto.randomUUID();
const B = crypto.randomUUID();
const TABELAS_AGENTE = [
  'crm_agente_config', 'crm_agente_conhecimento', 'crm_agente_execucoes', 'crm_handoffs', 'crm_anexos',
];
// Leads/Chamados (perfil kyvvo_atendimento) — mesma checagem genérica de
// tenant_id, tabelas novas e separadas de crm_pedidos/crm_etapas de
// propósito (ver db/046_crm_leads.sql).
const TABELAS_LEADS_CHAMADOS = ['crm_leads', 'crm_leads_etapas', 'crm_chamados'];

before(async () => { if (temBanco) await migrar(); });
after(async () => {
  if (!temBanco) return;
  for (const t of [A, B]) {
    await pool.query('delete from crm_agente_config where tenant_id = $1', [t]);
    await pool.query('delete from crm_campos_customizados where tenant_id = $1', [t]);
    await pool.query('delete from crm_mensagens_whatsapp where tenant_id = $1', [t]);
    await pool.query('delete from crm_whatsapp_numeros where tenant_id = $1', [t]);
  }
  await pool.end();
});

test('toda tabela nova do agente tem tenant_id uuid not null', opts, async () => {
  const { rows } = await pool.query(
    `select table_name, is_nullable, data_type from information_schema.columns
      where column_name = 'tenant_id' and table_name = any($1)`, [TABELAS_AGENTE]);
  assert.equal(rows.length, TABELAS_AGENTE.length);
  for (const r of rows) {
    assert.equal(r.data_type, 'uuid', r.table_name);
    assert.equal(r.is_nullable, 'NO', r.table_name);
  }
});

test('toda tabela de Leads/Chamados tem tenant_id uuid not null', opts, async () => {
  const { rows } = await pool.query(
    `select table_name, is_nullable, data_type from information_schema.columns
      where column_name = 'tenant_id' and table_name = any($1)`, [TABELAS_LEADS_CHAMADOS]);
  assert.equal(rows.length, TABELAS_LEADS_CHAMADOS.length);
  for (const r of rows) {
    assert.equal(r.data_type, 'uuid', r.table_name);
    assert.equal(r.is_nullable, 'NO', r.table_name);
  }
});

test('crm_agente_config.perfil_agente existe, default basic3d_producao_sob_encomenda', opts, async () => {
  const { rows } = await pool.query(
    `select column_default from information_schema.columns
      where table_name = 'crm_agente_config' and column_name = 'perfil_agente'`);
  assert.equal(rows.length, 1);
  assert.match(rows[0].column_default, /basic3d_producao_sob_encomenda/);
});

test('crm_conversas_whatsapp.turnos_contados_desde existe (fix do limite de turnos permanente)', opts, async () => {
  const { rows } = await pool.query(
    `select 1 from information_schema.columns
      where table_name = 'crm_conversas_whatsapp' and column_name = 'turnos_contados_desde'`);
  assert.equal(rows.length, 1);
});

test('seed da Basic (reaplicado depois do perfil_agente existir): continua 100% zero mudança de comportamento', opts, async () => {
  await semearAgente(pool, A, seed, { modo: 'rascunho' });
  const cfg = await pool.query('select perfil_agente from crm_agente_config where tenant_id = $1', [A]);
  assert.equal(cfg.rows[0].perfil_agente, 'basic3d_producao_sob_encomenda', 'seed sem perfil_agente na chave config deve cair no default, não ficar null');
});

test('seed da Basic: reproduzível (2x = mesmo estado) e isolado por tenant', opts, async () => {
  await semearAgente(pool, A, seed, { modo: 'rascunho' });
  await semearAgente(pool, A, seed, { modo: 'rascunho' });
  const campos = await pool.query("select chave from crm_campos_customizados where tenant_id = $1 and entidade = 'pedido'", [A]);
  assert.equal(campos.rows.length, seed.campos_pedido.length);
  const cfg = await pool.query('select * from crm_agente_config where tenant_id = $1', [A]);
  assert.equal(cfg.rows.length, 1);
  assert.equal(cfg.rows[0].modo, 'rascunho');
  assert.equal(cfg.rows[0].horario_atendimento.fuso, 'America/Sao_Paulo');
  assert.equal(cfg.rows[0].flags.status_automatico, false);

  // o outro tenant não enxerga nada do A
  const outro = await pool.query('select 1 from crm_agente_config where tenant_id = $1', [B]);
  assert.equal(outro.rows.length, 0);
  const outroCampos = await pool.query('select 1 from crm_campos_customizados where tenant_id = $1', [B]);
  assert.equal(outroCampos.rows.length, 0);
});

test('seed: modo padrão é desligado e número não pode ser roubado de outra conta', opts, async () => {
  await semearAgente(pool, B, seed, { phoneNumberId: 'pn-teste-agente', numeroExibido: '+5534900000000' });
  const cfg = await pool.query('select modo from crm_agente_config where tenant_id = $1', [B]);
  assert.equal(cfg.rows[0].modo, 'desligado');
  await assert.rejects(() => semearAgente(pool, A, seed, { phoneNumberId: 'pn-teste-agente' }), /outra conta/);
});

test('wamid é único por tenant (mesmo wamid em contas diferentes é ok)', opts, async () => {
  const ins = (tenant, wamid) => pool.query(
    `insert into crm_mensagens_whatsapp (tenant_id, telefone_e164, direcao, conteudo, wamid)
     values ($1, '+5534911110000', 'recebida', 'oi', $2)`, [tenant, wamid]);
  await ins(A, 'wamid.X1');
  await ins(B, 'wamid.X1');
  await assert.rejects(() => ins(A, 'wamid.X1'), /duplicate key|crm_mensagens_whatsapp_wamid_uniq/);
});

test('campo customizado: mesma chave pode existir em cliente e pedido', opts, async () => {
  await pool.query("insert into crm_campos_customizados (tenant_id, entidade, chave, label, tipo) values ($1,'cliente','cor','Cor','texto')", [A]);
  const r = await pool.query("select count(*)::int n from crm_campos_customizados where tenant_id=$1 and chave='cor'", [A]);
  assert.ok(r.rows[0].n >= 1);
});
