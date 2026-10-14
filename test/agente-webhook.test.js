const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temBanco = !!process.env.DATABASE_URL;
const opts = temBanco ? {} : { skip: 'sem DATABASE_URL' };

const { pool, migrar } = require('../lib/db');
const { build } = require('../index');
const { criarAgente } = require('../lib/agente');
const { semearAgente } = require('../lib/agente/seed');
const { extrairMudancas, normalizarMensagem } = require('../lib/agente/entrada');
const { processarConversa, varrerPendentes, midiaPermitida } = require('../lib/agente/processador');
const { criarArmazenamentoDisco } = require('../lib/armazenamento');

const SEGREDO = 'segredo-de-teste';
const T1 = crypto.randomUUID();
const T2 = crypto.randomUUID();
const PN1 = `pn-${T1.slice(0, 8)}`;
const PN2 = `pn-${T2.slice(0, 8)}`;
const PN_OFF = `pn-off-${T1.slice(0, 8)}`;
const FONE = '5534988880001';
const E164 = '+5534988880001';
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'db', 'seeds', 'basic.json'), 'utf8'));
// Este arquivo testa o tratamento SÍNCRONO do webhook (tratarWebhook ->
// processarConversa na hora, coletado em `processamentos`) — sem isso, o
// delay_resposta_segundos da Basic faria tratarWebhook pular o processamento
// e esperar a varredura periódica, que não roda neste teste (iniciarVarredura
// é um stub acima). O atraso em si tem teste próprio (ver 'atraso de resposta').
delete seed.config.limites.delay_resposta_segundos;

let dir; let app; let chamadas; let processamentos; let midias;

function payload(pn, { mensagens = [], statuses = [], campo = 'messages', ecos } = {}) {
  const value = { messaging_product: 'whatsapp', metadata: { phone_number_id: pn }, contacts: [{ wa_id: FONE, profile: { name: 'Maria' } }], messages: mensagens, statuses };
  if (ecos) value.message_echoes = ecos;
  return { object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: campo, value }] }] };
}
const texto = (id, body = 'oi') => ({ id, from: FONE, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } });

async function enviar(body, segredo = SEGREDO) {
  const res = await app.inject({ method: 'POST', url: '/crm/api/webhook/whatsapp', headers: { 'x-webhook-internal-secret': segredo }, payload: body });
  await Promise.all(processamentos.splice(0));
  return res;
}

before(async () => {
  if (!temBanco) return;
  process.env.WEBHOOK_INTERNAL_SECRET = SEGREDO;
  await migrar();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agente-'));
  chamadas = []; processamentos = []; midias = {};
  const real = criarAgente(pool, {
    armazenamento: criarArmazenamentoDisco(dir),
    baixarMidia: async (id) => { if (!midias[id]) throw new Error('mídia inexistente'); return midias[id]; },
    executarAgente: async (ctx) => { chamadas.push(ctx.mensagens.map((m) => m.conteudo)); },
    log: () => {},
  });
  app = await build({
    agente: {
      deps: real.deps,
      iniciarVarredura() {},
      async tratarWebhook(body) { const r = await real.tratarWebhook(body); processamentos.push(...r.processamentos); return r; },
    },
  });
  await semearAgente(pool, T1, seed, { modo: 'rascunho', phoneNumberId: PN1 });
  await semearAgente(pool, T2, seed, { modo: 'rascunho', phoneNumberId: PN2 });
  await semearAgente(pool, T1, seed, { modo: 'rascunho', phoneNumberId: PN1 });
  // número com agente desligado
  await pool.query("insert into crm_whatsapp_numeros (phone_number_id, tenant_id) values ($1, $2)", [PN_OFF, T2]);
  await pool.query("update crm_agente_config set modo = 'desligado' where tenant_id = $1", [T2]);
});

after(async () => {
  if (!temBanco) return;
  await app.close();
  for (const t of [T1, T2]) {
    for (const tab of ['crm_anexos', 'crm_mensagens_whatsapp', 'crm_conversas_whatsapp', 'crm_agente_config', 'crm_campos_customizados', 'crm_whatsapp_numeros']) {
      await pool.query(`delete from ${tab} where tenant_id = $1`, [t]);
    }
  }
  await pool.end();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('segredo interno inválido: 401 e nada gravado', opts, async () => {
  const res = await enviar(payload(PN1, { mensagens: [texto('wamid.SEC1')] }), 'errado');
  assert.equal(res.statusCode, 401);
  const r = await pool.query("select 1 from crm_mensagens_whatsapp where wamid = 'wamid.SEC1'");
  assert.equal(r.rows.length, 0);
});

test('reentrega do mesmo wamid não duplica mensagem nem roda o agente de novo', opts, async () => {
  chamadas.length = 0;
  const body = payload(PN1, { mensagens: [texto('wamid.R1', 'quero um cortador')] });
  assert.equal((await enviar(body)).statusCode, 200);
  assert.equal((await enviar(body)).statusCode, 200);
  const r = await pool.query("select * from crm_mensagens_whatsapp where tenant_id = $1 and wamid = 'wamid.R1'", [T1]);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].autor, 'cliente');
  assert.ok(r.rows[0].processada_em);
  assert.deepEqual(chamadas, [['quero um cortador']]);
  const c = await pool.query('select * from crm_conversas_whatsapp where tenant_id = $1 and telefone_e164 = $2', [T1, E164]);
  assert.equal(c.rows[0].situacao, 'bot');
  assert.equal(c.rows[0].nome_whatsapp, 'Maria');
  assert.ok(new Date(c.rows[0].janela_expira_em) - new Date(c.rows[0].ultima_msg_cliente_em) === 24 * 3600 * 1000);
});

test('número com agente desligado não é tratado pelo agente', opts, async () => {
  const { carregarCanalAtivo } = require('../lib/agente/recebimento');
  assert.equal(await carregarCanalAtivo(pool, PN_OFF), null);
  assert.ok(await carregarCanalAtivo(pool, PN1));
});

test('imagem vai para o armazenamento sob o prefixo do tenant, com sha256', opts, async () => {
  const bytes = Buffer.from('fake-png-bytes');
  midias.M1 = { buffer: bytes, tipoMime: 'image/png' };
  await enviar(payload(PN1, { mensagens: [{ id: 'wamid.IMG1', from: FONE, timestamp: String(Math.floor(Date.now() / 1000)), type: 'image', image: { id: 'M1', mime_type: 'image/png', caption: 'minha logo' } }] }));
  const { rows } = await pool.query('select a.* from crm_anexos a join crm_mensagens_whatsapp m on m.anexo_id = a.id where m.tenant_id = $1 and m.wamid = $2', [T1, 'wamid.IMG1']);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].chave_armazenamento.startsWith(`${T1}/`));
  assert.equal(rows[0].sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(rows[0].tenant_id, T1);
  assert.deepEqual(fs.readFileSync(path.join(dir, rows[0].chave_armazenamento)), bytes);
});

test('tipo de arquivo não permitido: sem anexo, mensagem segue e erro fica registrado', opts, async () => {
  midias.M2 = { buffer: Buffer.from('MZ'), tipoMime: 'application/x-msdownload' };
  await enviar(payload(PN1, { mensagens: [{ id: 'wamid.EXE1', from: FONE, timestamp: String(Math.floor(Date.now() / 1000)), type: 'document', document: { id: 'M2', filename: 'a.exe', mime_type: 'application/x-msdownload' } }] }));
  const { rows } = await pool.query("select anexo_id, midia, processada_em from crm_mensagens_whatsapp where tenant_id = $1 and wamid = 'wamid.EXE1'", [T1]);
  assert.equal(rows[0].anexo_id, null);
  assert.match(rows[0].midia.erro, /não permitido/);
  assert.ok(rows[0].processada_em);
});

test('STL como octet-stream só passa com extensão de modelo 3D', () => {
  assert.equal(midiaPermitida({ mime: 'application/octet-stream', nomeArquivo: 'peca.STL' }), true);
  assert.equal(midiaPermitida({ mime: 'application/octet-stream', nomeArquivo: 'x.exe' }), false);
  assert.equal(midiaPermitida({ mime: 'image/jpeg' }), true);
});

test('áudio é registrado, nunca baixado', opts, async () => {
  let baixou = false;
  midias.AUD = { get buffer() { baixou = true; return Buffer.alloc(1); }, tipoMime: 'audio/ogg' };
  await enviar(payload(PN1, { mensagens: [{ id: 'wamid.AUD1', from: FONE, timestamp: String(Math.floor(Date.now() / 1000)), type: 'audio', audio: { id: 'AUD' } }] }));
  const { rows } = await pool.query("select tipo, conteudo, anexo_id from crm_mensagens_whatsapp where tenant_id = $1 and wamid = 'wamid.AUD1'", [T1]);
  assert.equal(rows[0].tipo, 'audio');
  assert.equal(rows[0].anexo_id, null);
  assert.equal(baixou, false);
});

test('status de entrega e categoria de cobrança atualizam só o tenant do número', opts, async () => {
  await pool.query(
    "insert into crm_mensagens_whatsapp (tenant_id, telefone_e164, direcao, conteudo, wamid, autor) values ($1, $2, 'enviada', 'x', 'wamid.OUT1', 'agente'), ($3, $2, 'enviada', 'x', 'wamid.OUT1', 'agente')",
    [T1, E164, T2]);
  await enviar(payload(PN1, { statuses: [{ id: 'wamid.OUT1', status: 'delivered', pricing: { category: 'service' } }] }));
  const { rows } = await pool.query("select tenant_id, status_entrega, categoria_cobranca from crm_mensagens_whatsapp where wamid = 'wamid.OUT1' order by tenant_id");
  const t1 = rows.find((r) => r.tenant_id === T1);
  const t2 = rows.find((r) => r.tenant_id === T2);
  assert.equal(t1.status_entrega, 'delivered');
  assert.equal(t1.categoria_cobranca, 'service');
  assert.equal(t2.status_entrega, null);
});

test('eco do app (coexistência) coloca a conversa em humano e o agente fica em silêncio', opts, async () => {
  chamadas.length = 0;
  await enviar(payload(PN1, { campo: 'smb_message_echoes', ecos: [{ id: 'wamid.ECO1', from: '553495330139', to: FONE, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Oi, aqui é a equipe' } }] }));
  const c = await pool.query('select situacao, pausada_ate from crm_conversas_whatsapp where tenant_id = $1 and telefone_e164 = $2', [T1, E164]);
  assert.equal(c.rows[0].situacao, 'humano');
  assert.ok(new Date(c.rows[0].pausada_ate) > new Date());
  const eco = await pool.query("select autor, direcao from crm_mensagens_whatsapp where tenant_id = $1 and wamid = 'wamid.ECO1'", [T1]);
  assert.deepEqual(eco.rows[0], { autor: 'humano', direcao: 'enviada' });

  await enviar(payload(PN1, { mensagens: [texto('wamid.PAUSA1', 'e o orçamento?')] }));
  assert.deepEqual(chamadas, []);
  const m = await pool.query("select processada_em from crm_mensagens_whatsapp where tenant_id = $1 and wamid = 'wamid.PAUSA1'", [T1]);
  assert.ok(m.rows[0].processada_em);
});

test('falha do agente não perde a mensagem: tentativas sobem e a varredura reprocessa', opts, async () => {
  await pool.query("update crm_conversas_whatsapp set situacao = 'bot', pausada_ate = null where tenant_id = $1", [T1]);
  let falhar = true; const vistas = [];
  const deps = { ...app.agente.deps, executarAgente: async (ctx) => { if (ctx.tenantId !== T1) return; if (falhar) throw new Error('modelo fora do ar'); vistas.push(ctx.mensagens.map((x) => x.conteudo)); } };
  const { rows: [conv] } = await pool.query('select id from crm_conversas_whatsapp where tenant_id = $1 and telefone_e164 = $2', [T1, E164]);
  await pool.query(
    "insert into crm_mensagens_whatsapp (tenant_id, telefone_e164, direcao, conteudo, wamid, autor, criado_em) values ($1, $2, 'recebida', 'segunda', 'wamid.F2', 'cliente', now() - interval '2 minutes'), ($1, $2, 'recebida', 'primeira', 'wamid.F1', 'cliente', now() - interval '3 minutes')",
    [T1, E164]);
  const r1 = await processarConversa(pool, T1, conv.id, deps);
  assert.equal(r1.processadas, 0);
  let m = await pool.query("select tentativas, processada_em from crm_mensagens_whatsapp where tenant_id = $1 and wamid = 'wamid.F1'", [T1]);
  assert.equal(m.rows[0].tentativas, 1);
  assert.equal(m.rows[0].processada_em, null);

  falhar = false;
  assert.ok(await varrerPendentes(pool, deps, { esperaSegundos: 1 }) >= 1);
  assert.deepEqual(vistas, [['primeira', 'segunda']]); // ordem preservada, um turno só
  m = await pool.query("select processada_em from crm_mensagens_whatsapp where tenant_id = $1 and wamid = 'wamid.F1'", [T1]);
  assert.ok(m.rows[0].processada_em);
});

test('conta com delay_resposta_segundos configurado não processa na hora, só na varredura depois do atraso', opts, async () => {
  await pool.query("update crm_agente_config set limites = limites || '{\"delay_resposta_segundos\": 240}'::jsonb where tenant_id = $1", [T1]);
  try {
    chamadas.length = 0;
    const res = await enviar(payload(PN1, { mensagens: [texto('wamid.DELAY1', 'quero um ejetor')] }));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(chamadas, []); // tratarWebhook não chamou processarConversa na hora
    let m = await pool.query("select processada_em from crm_mensagens_whatsapp where tenant_id = $1 and wamid = 'wamid.DELAY1'", [T1]);
    assert.equal(m.rows[0].processada_em, null);

    // Simula o tempo passando (em vez de esperar de verdade): a varredura só
    // pega mensagem mais velha que esperaSegundos.
    await pool.query("update crm_mensagens_whatsapp set criado_em = now() - interval '5 minutes' where tenant_id = $1 and wamid = 'wamid.DELAY1'", [T1]);
    await varrerPendentes(pool, app.agente.deps, { esperaSegundos: 240 });
    assert.deepEqual(chamadas, [['quero um ejetor']]);
    m = await pool.query("select processada_em from crm_mensagens_whatsapp where tenant_id = $1 and wamid = 'wamid.DELAY1'", [T1]);
    assert.ok(m.rows[0].processada_em);
  } finally {
    await pool.query("update crm_agente_config set limites = limites - 'delay_resposta_segundos' where tenant_id = $1", [T1]);
  }
});

test('entrada.js: tipos normalizados e statuses extraídos', () => {
  assert.equal(normalizarMensagem({ id: 'a', from: '1', type: 'sticker' }).tipo, 'figurinha');
  assert.equal(normalizarMensagem({ id: 'a', from: '1', type: 'location', location: {} }).tipo, 'localizacao');
  assert.equal(normalizarMensagem({ id: 'a', from: '1', type: 'reaction' }).tipo, 'outro');
  const [mud] = extrairMudancas(payload('p', { statuses: [{ id: 'w', status: 'read', conversation: { origin: { type: 'service' } } }] }));
  assert.deepEqual(mud.statuses[0], { wamid: 'w', status: 'read', categoria: 'service' });
});

test('armazenamento: leitura de chave de outro tenant e path traversal falham', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-'));
  try {
    const arm = criarArmazenamentoDisco(d);
    const { chave } = await arm.salvar({ tenantId: 'tenant-a', nomeArquivo: '../../evil.png', buffer: Buffer.from('x') });
    assert.ok(chave.startsWith('tenant-a/'));
    assert.ok(!chave.includes('..'));
    assert.equal((await arm.ler('tenant-a', chave)).toString(), 'x');
    await assert.rejects(() => arm.ler('tenant-b', chave), /fora do tenant/);
    await assert.rejects(() => arm.ler('tenant-a', 'tenant-a/../tenant-b/x'), /inválida/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
