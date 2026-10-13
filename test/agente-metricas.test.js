const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
const temBanco = !!process.env.DATABASE_URL;
const opts = temBanco ? {} : { skip: 'sem DATABASE_URL' };

const { pool, migrar } = require('../lib/db');
const { build } = require('../index');
const platform = require('../lib/platform');
const { custoUsd } = require('../lib/agente/precos');
const { calcular } = require('../lib/agente/metricas');
const { expurgarLogs } = require('../lib/agente/retencao');
const { executarTurno } = require('../lib/agente/executor');
const { processarConversa } = require('../lib/agente/processador');
const { criarAgente } = require('../lib/agente');
const { semearAgente } = require('../lib/agente/seed');

const A = crypto.randomUUID();
const B = crypto.randomUUID();
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'db', 'seeds', 'basic.json'), 'utf8'));
let app; let seq = 0; let tenantAtual = A;

async function conversa(tenant, nome = 'Maria') {
  const fone = `+5534944${String(10000 + (seq += 1))}`;
  const { rows: [c] } = await pool.query(
    `insert into crm_conversas_whatsapp (tenant_id, telefone_e164, estado, situacao, janela_expira_em, nome_whatsapp)
     values ($1, $2, 'agente', 'bot', now() + interval '24 hours', $3) returning *`, [tenant, fone, nome]);
  return c;
}
const execucao = (tenant, conv, { modelo = 'claude-haiku-5-5', tin = 0, tout = 0, bloqueada = false, decisao = null, diasAtras = 0 } = {}) => pool.query(
  `insert into crm_agente_execucoes (tenant_id, conversa_id, modelo, tokens_in, tokens_out, bloqueada_por_filtro, decisao, criado_em)
   values ($1, $2, $3, $4, $5, $6, $7, now() - make_interval(days => $8))`, [tenant, conv.id, modelo, tin, tout, bloqueada, decisao, diasAtras]);

before(async () => {
  if (!temBanco) return;
  await migrar();
  platform.verifyToken = async () => ({ tenantId: tenantAtual, userId: crypto.randomUUID(), email: 'a@b.com', tokenVersion: 0 });
  app = await build({ agente: { deps: {}, iniciarVarredura() {}, iniciarRetencao() {}, async tratarWebhook() { return { tratados: new Set() }; } } });
  for (const t of [A, B]) {
    await semearAgente(pool, t, seed, { modo: 'rascunho', phoneNumberId: `pn-${t.slice(0, 8)}` });
    await pool.query("insert into crm_etapas (tenant_id, nome, ordem, tipo, fixa) values ($1, 'A fazer', 1, 'aberta', true)", [t]);
  }
});

after(async () => {
  if (!temBanco) return;
  await app.close();
  for (const t of [A, B]) {
    for (const tab of ['crm_handoffs', 'crm_agente_execucoes', 'crm_eventos', 'crm_pedidos', 'crm_mensagens_whatsapp', 'crm_conversas_whatsapp', 'crm_clientes', 'crm_etapas',
      'crm_agente_conhecimento', 'crm_agente_config', 'crm_campos_customizados', 'crm_whatsapp_numeros']) {
      await pool.query(`delete from ${tab} where tenant_id = $1`, [t]);
    }
  }
  await pool.end();
});

test('preço: custo por modelo e modelo desconhecido não inventa valor', () => {
  assert.ok(Math.abs(custoUsd('claude-haiku-5-5', 1_000_000, 100_000) - 0.15) < 1e-9);
  assert.equal(custoUsd('claude-haiku-4-5', 1_000_000, 1_000_000), 6);
  assert.equal(custoUsd('modelo-novo', 10, 10), null);
});

test('métricas: custo, bloqueios, decisões, mensagens e custo por conversa', opts, async () => {
  const c1 = await conversa(A, 'Ana');
  const c2 = await conversa(A, 'Bia');
  await execucao(A, c1, { tin: 600_000, tout: 60_000, decisao: 'aprovada' });
  await execucao(A, c1, { tin: 400_000, tout: 40_000, decisao: 'editada' });
  await execucao(A, c2, { tin: 1_000, tout: 100, bloqueada: true, decisao: 'descartada' });
  await execucao(A, c2, { modelo: null }); // turno sem modelo (áudio): não conta como chamada
  await execucao(A, c2, { tin: 5_000_000, tout: 0, diasAtras: 30 }); // fora do período de 7 dias
  for (const [fone, autor, cat] of [[c1.telefone_e164, 'agente', 'service'], [c1.telefone_e164, 'humano', null], [c2.telefone_e164, 'agente', null]]) {
    await pool.query("insert into crm_mensagens_whatsapp (tenant_id, telefone_e164, direcao, tipo, conteudo, autor, categoria_cobranca) values ($1, $2, 'enviada', 'texto', 'x', $3, $4)", [A, fone, autor, cat]);
  }
  const m = await calcular(pool, A, { dias: 7 });
  assert.equal(m.execucoes.total, 4);
  assert.equal(m.execucoes.chamadas_ao_modelo, 3);
  assert.equal(m.execucoes.bloqueadas_pelo_filtro, 1);
  assert.equal(m.execucoes.taxa_bloqueio, 0.25);
  assert.deepEqual([m.sugestoes.aprovadas, m.sugestoes.editadas, m.sugestoes.descartadas], [1, 1, 1]);
  assert.equal(m.sugestoes.taxa_aprovada_sem_edicao, 0.3333);
  assert.equal(m.custo.tokens.entrada, 1_001_000);
  assert.equal(m.custo.tokens.saida, 100_100);
  assert.equal(m.custo.ia_usd, Number(((1_001_000 * 0.1 + 100_100 * 0.5) / 1e6).toFixed(6)));
  assert.equal(m.custo.mensagens_enviadas, 3);
  assert.deepEqual(m.custo.mensagens_por_categoria.map((x) => [x.categoria, x.n]).sort(), [['sem_categoria', 2], ['service', 1]]);
  assert.equal(m.custo.meta_usd_estimado, null); // valor oficial da Meta ainda não configurado
  assert.equal(m.por_conversa[0].nome, 'Ana'); // a mais cara primeiro
  assert.equal(m.por_conversa[0].turnos, 2);
  assert.equal(m.por_conversa[0].msgs_enviadas, 2);
  const longo = await calcular(pool, A, { dias: 60 });
  assert.equal(longo.execucoes.total, 5);
  await pool.query("update crm_agente_config set limites = limites || '{\"custo_mensagem_meta_usd\": 0.01}' where tenant_id = $1", [A]);
  assert.equal((await calcular(pool, A, { dias: 7 })).custo.meta_usd_estimado, 0.03);
});

test('métricas: tempo até o primeiro atendimento humano e fila aberta', opts, async () => {
  const c = await conversa(A, 'Clara');
  const { rows: [h] } = await pool.query("insert into crm_handoffs (tenant_id, conversa_id, motivo, criado_em) values ($1, $2, 'urgencia', now() - interval '30 minutes') returning id", [A, c.id]);
  await pool.query("insert into crm_mensagens_whatsapp (tenant_id, telefone_e164, direcao, tipo, conteudo, autor, criado_em) values ($1, $2, 'enviada', 'texto', 'oi', 'humano', now() - interval '20 minutes')", [A, c.telefone_e164]);
  const c2 = await conversa(A, 'Dora');
  await pool.query("insert into crm_handoffs (tenant_id, conversa_id, motivo, criado_em) values ($1, $2, 'reclamacao', now() - interval '90 minutes')", [A, c2.id]);
  const m = await calcular(pool, A, { dias: 1 });
  assert.equal(m.atendimento_humano.respondidos >= 1, true);
  assert.equal(m.atendimento_humano.media_min >= 9.9 && m.atendimento_humano.media_min <= 10.1 || m.atendimento_humano.respondidos > 1, true);
  assert.ok(m.fila.abertos >= 2);
  assert.ok(m.fila.mais_antigo_min >= 90);
  assert.ok(h.id);
});

test('métricas: alertas de teto diário (aviso a 80%, crítico a 100%) e fila parada', opts, async () => {
  await pool.query("update crm_agente_config set limites = '{\"teto_diario_tokens\": 1000, \"tempo_alvo_resposta_min\": 60}' where tenant_id = $1", [B]);
  const c = await conversa(B);
  await pool.query("insert into crm_handoffs (tenant_id, conversa_id, motivo, criado_em) values ($1, $2, 'urgencia', now() - interval '2 hours')", [B, c.id]);
  await execucao(B, c, { tin: 600, tout: 250 });
  let m = await calcular(pool, B, { dias: 7 });
  assert.equal(m.teto_diario.uso, 0.85);
  assert.ok(m.alertas.some((a) => a.codigo === 'teto_diario' && a.nivel === 'aviso'));
  assert.ok(m.alertas.some((a) => a.codigo === 'fila_parada'));
  await execucao(B, c, { tin: 200, tout: 0 });
  m = await calcular(pool, B, { dias: 7 });
  assert.ok(m.alertas.some((a) => a.codigo === 'teto_diario' && a.nivel === 'critico'));
});

test('métricas: isolamento por conta e rota autenticada', opts, async () => {
  const semDados = crypto.randomUUID();
  const vazio = await calcular(pool, semDados, { dias: 7 });
  assert.equal(vazio.execucoes.total, 0);
  assert.equal(vazio.custo.mensagens_enviadas, 0);
  assert.deepEqual(vazio.por_conversa, []);
  assert.equal((await app.inject({ method: 'GET', url: '/crm/api/agente/metricas' })).statusCode, 401);
  tenantAtual = semDados;
  const r = await app.inject({ method: 'GET', url: '/crm/api/agente/metricas?dias=7', headers: { authorization: 'Bearer t' } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().execucoes.total, 0);
  tenantAtual = A;
  const r2 = await app.inject({ method: 'GET', url: '/crm/api/agente/metricas?dias=7', headers: { authorization: 'Bearer t' } });
  assert.ok(r2.json().execucoes.total > 0);
});

test('rate limit por número: excesso de mensagens na hora para o agente e chama a equipe', opts, async () => {
  await pool.query("update crm_agente_config set limites = '{\"max_msgs_por_hora\": 3}' where tenant_id = $1", [A]);
  const c = await conversa(A, 'Spam');
  const ms = [];
  for (let i = 0; i < 5; i += 1) {
    const { rows: [m] } = await pool.query("insert into crm_mensagens_whatsapp (tenant_id, telefone_e164, direcao, tipo, conteudo, wamid, autor) values ($1, $2, 'recebida', 'texto', $3, $4, 'cliente') returning *", [A, c.telefone_e164, `msg ${i}`, `w.${crypto.randomUUID()}`]);
    ms.push(m);
  }
  let chamouModelo = false;
  const ia = { criarMensagem: async () => { chamouModelo = true; throw new Error('não deveria chamar'); } };
  const r = await executarTurno({ pool, tenantId: A, conversa: c, mensagens: ms }, { ia, agora: () => new Date('2026-10-12T15:00:00Z'), enviarTexto: async () => true, log: () => {} });
  assert.equal(r.limite, 'mensagens');
  assert.equal(chamouModelo, false);
  const { rows: [h] } = await pool.query('select motivo from crm_handoffs where conversa_id = $1', [c.id]);
  assert.equal(h.motivo, 'rate_limit');
  await pool.query("update crm_agente_config set limites = '{}' where tenant_id = $1", [A]);
});

test('retenção: apaga execuções antigas só de quem definiu o prazo', opts, async () => {
  const ca = await conversa(A); const cb = await conversa(B);
  await execucao(A, ca, { diasAtras: 100 }); await execucao(A, ca, { diasAtras: 1 });
  await execucao(B, cb, { diasAtras: 100 });
  await pool.query('update crm_agente_config set retencao_logs_dias = 30 where tenant_id = $1', [A]);
  await pool.query('update crm_agente_config set retencao_logs_dias = null where tenant_id = $1', [B]);
  const r = await expurgarLogs(pool);
  assert.ok(r.some((x) => x.tenant_id === A && x.execucoes_apagadas >= 1));
  assert.ok(!r.some((x) => x.tenant_id === B));
  const restantesA = await pool.query("select count(*)::int n from crm_agente_execucoes where tenant_id = $1 and conversa_id = $2", [A, ca.id]);
  assert.equal(restantesA.rows[0].n, 1); // a de 1 dia fica
  const restantesB = await pool.query("select count(*)::int n from crm_agente_execucoes where tenant_id = $1 and conversa_id = $2", [B, cb.id]);
  assert.equal(restantesB.rows[0].n, 1); // sem prazo definido: nada apagado
});

test('chave de desligamento: desligado devolve o webhook ao bot antigo; religar volta ao agente', opts, async () => {
  const agente = criarAgente(pool, { log: () => {} });
  const pn = `pn-${A.slice(0, 8)}`;
  const corpo = { entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: pn }, contacts: [{ wa_id: '5534900001111', profile: { name: 'X' } }],
    messages: [{ id: `wamid.${crypto.randomUUID()}`, from: '5534900001111', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'oi' } }] } }] }] };
  await pool.query("update crm_agente_config set modo = 'desligado' where tenant_id = $1", [A]);
  const off = await agente.tratarWebhook(corpo);
  assert.equal(off.tratados.size, 0);
  const sem = await pool.query("select count(*)::int n from crm_mensagens_whatsapp where tenant_id = $1 and telefone_e164 = '+5534900001111'", [A]);
  assert.equal(sem.rows[0].n, 0); // nada gravado pelo agente
  await pool.query("update crm_agente_config set modo = 'rascunho' where tenant_id = $1", [A]);
  corpo.entry[0].changes[0].value.messages[0].id = `wamid.${crypto.randomUUID()}`;
  const on = await agente.tratarWebhook({ ...corpo });
  await Promise.all(on.processamentos);
  assert.ok(on.tratados.has(pn));
});

test('desligar com mensagem pendente: o turno não gera resposta nem chama o modelo', opts, async () => {
  const c = await conversa(A, 'Pendente');
  await pool.query("insert into crm_mensagens_whatsapp (tenant_id, telefone_e164, direcao, tipo, conteudo, wamid, autor) values ($1, $2, 'recebida', 'texto', 'oi?', $3, 'cliente')", [A, c.telefone_e164, `w.${crypto.randomUUID()}`]);
  await pool.query("update crm_agente_config set modo = 'desligado' where tenant_id = $1", [A]);
  let chamou = false;
  const deps = { executarAgente: (t) => executarTurno(t, { ia: { criarMensagem: async () => { chamou = true; throw new Error('x'); } }, enviarTexto: async () => { chamou = true; return true; }, log: () => {} }), log: () => {} };
  const r = await processarConversa(pool, A, c.id, deps);
  assert.equal(r.processadas, 1);
  assert.equal(chamou, false);
  const { rows } = await pool.query('select count(*)::int n from crm_agente_execucoes where conversa_id = $1', [c.id]);
  assert.equal(rows[0].n, 0);
  await pool.query("update crm_agente_config set modo = 'rascunho' where tenant_id = $1", [A]);
});
