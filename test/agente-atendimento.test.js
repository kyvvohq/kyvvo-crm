const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.NODE_ENV = 'test';
const temBanco = !!process.env.DATABASE_URL;
const opts = temBanco ? {} : { skip: 'sem DATABASE_URL' };

const { pool, migrar } = require('../lib/db');
const { build } = require('../index');
const platform = require('../lib/platform');
const { criarArmazenamentoDisco } = require('../lib/armazenamento');
const { processarConversa } = require('../lib/agente/processador');
const { semearAgente } = require('../lib/agente/seed');

const A = crypto.randomUUID();
const B = crypto.randomUUID();
const USUARIO = crypto.randomUUID();
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'db', 'seeds', 'basic.json'), 'utf8'));

let app; let dir; let enviados; let tenantAtual = A;
let seq = 0;

const req = (method, url, body, tenant = A) => {
  tenantAtual = tenant;
  return app.inject({ method, url, headers: { authorization: 'Bearer t' }, ...(body !== undefined ? { payload: body } : {}) });
};

async function novaConversa(tenant, { situacao = 'bot', janelaHoras = 24, proposta = null, handoff = null, vip = false, nome = 'Maria' } = {}) {
  const fone = `+5534955${String(10000 + (seq += 1))}`;
  const { rows: [conv] } = await pool.query(
    `insert into crm_conversas_whatsapp (tenant_id, telefone_e164, estado, situacao, ultima_msg_cliente_em, janela_expira_em, nome_whatsapp)
     values ($1, $2, 'agente', $3, now(), now() + make_interval(hours => $4), $5) returning *`, [tenant, fone, situacao, janelaHoras, nome]);
  const { rows: [msg] } = await pool.query(
    `insert into crm_mensagens_whatsapp (tenant_id, telefone_e164, direcao, tipo, conteudo, wamid, autor)
     values ($1, $2, 'recebida', 'texto', 'quero um chaveiro', $3, 'cliente') returning *`, [tenant, fone, `w.${crypto.randomUUID()}`]);
  let execucao = null;
  if (proposta) {
    const { rows: [e] } = await pool.query(
      `insert into crm_agente_execucoes (tenant_id, conversa_id, mensagem_entrada_id, modelo, resposta_proposta) values ($1, $2, $3, 'claude-haiku-5-5', $4) returning *`,
      [tenant, conv.id, msg.id, proposta]);
    execucao = e;
  }
  if (handoff) {
    await pool.query(
      `insert into crm_handoffs (tenant_id, conversa_id, motivo, resumo, eh_vip) values ($1, $2, $3, 'resumo do caso', $4)`, [tenant, conv.id, handoff, vip]);
  }
  return { conv, msg, execucao };
}

before(async () => {
  if (!temBanco) return;
  await migrar();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atend-'));
  enviados = [];
  platform.verifyToken = async () => ({ tenantId: tenantAtual, userId: USUARIO, email: 'a@b.com', tokenVersion: 0 });
  const armazenamento = criarArmazenamentoDisco(dir);
  app = await build({
    agente: {
      deps: { armazenamento, enviarTexto: async (p) => { enviados.push(p); return true; }, log: () => {} },
      iniciarVarredura() {},
      async tratarWebhook() { return { tratados: new Set(), processamentos: [] }; },
    },
  });
  for (const t of [A, B]) {
    await semearAgente(pool, t, seed, { modo: 'rascunho', phoneNumberId: `pn-${t.slice(0, 8)}` });
    await pool.query("insert into crm_etapas (tenant_id, nome, ordem, tipo, fixa) values ($1, 'A fazer', 1, 'aberta', true)", [t]);
  }
});

after(async () => {
  if (!temBanco) return;
  await app.close();
  for (const t of [A, B]) {
    for (const tab of ['crm_handoffs', 'crm_agente_execucoes', 'crm_eventos', 'crm_anexos', 'crm_pedidos', 'crm_mensagens_whatsapp', 'crm_conversas_whatsapp',
      'crm_clientes', 'crm_etapas', 'crm_agente_conhecimento', 'crm_agente_config', 'crm_campos_customizados', 'crm_whatsapp_numeros']) {
      await pool.query(`delete from ${tab} where tenant_id = $1`, [t]);
    }
  }
  await pool.end();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sem login: 401 em todas as rotas de atendimento', opts, async () => {
  for (const [m, u] of [['GET', '/crm/api/agente/conversas'], ['GET', '/crm/api/agente/config'], ['POST', '/crm/api/agente/sugestoes/x/enviar'], ['POST', '/crm/api/agente/conversas/x/assumir']]) {
    const r = await app.inject({ method: m, url: u });
    assert.equal(r.statusCode, 401, `${m} ${u}`);
  }
});

test('lista: encaminhamento em destaque (VIP primeiro) e sugestão pendente sinalizada', opts, async () => {
  const comum = await novaConversa(A, { handoff: 'reclamacao' });
  const vip = await novaConversa(A, { handoff: 'pedido_humano', vip: true });
  const so = await novaConversa(A, { proposta: 'Oi! Qual o modelo?' });
  const r = await req('GET', '/crm/api/agente/conversas');
  assert.equal(r.statusCode, 200);
  const ids = r.json().map((c) => c.id);
  assert.ok(ids.indexOf(vip.conv.id) < ids.indexOf(comum.conv.id), 'VIP vem antes');
  assert.ok(ids.indexOf(comum.conv.id) < ids.indexOf(so.conv.id), 'com encaminhamento vem antes de sem');
  const item = r.json().find((c) => c.id === so.conv.id);
  assert.equal(item.sugestao_pendente, true);
  assert.equal(item.cliente_nome, 'Maria');
  const h = r.json().find((c) => c.id === vip.conv.id);
  assert.equal(h.handoff_rotulo, 'Pediu para falar com uma pessoa');
  assert.equal(h.eh_vip, true);
  // filtro por situação
  const so2 = await req('GET', '/crm/api/agente/conversas?situacao=humano');
  assert.ok(!so2.json().some((c) => c.id === so.conv.id));
});

test('rascunho → aprovar → enviar: manda pela Cloud API e registra a decisão', opts, async () => {
  const x = await novaConversa(A, { proposta: 'Oi, Maria! Qual o modelo do chaveiro?' });
  const det = (await req('GET', `/crm/api/agente/conversas/${x.conv.id}`)).json();
  assert.equal(det.sugestao.texto, 'Oi, Maria! Qual o modelo do chaveiro?');
  assert.equal(det.conversa.janela_aberta, true);
  enviados.length = 0;
  const r = await req('POST', `/crm/api/agente/sugestoes/${x.execucao.id}/enviar`, {});
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().decisao, 'aprovada');
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].to, x.conv.telefone_e164);
  assert.equal(enviados[0].texto, 'Oi, Maria! Qual o modelo do chaveiro?');
  assert.equal(enviados[0].phoneNumberId, `pn-${A.slice(0, 8)}`);
  const { rows: [e] } = await pool.query('select decisao, resposta_enviada from crm_agente_execucoes where id = $1', [x.execucao.id]);
  assert.equal(e.decisao, 'aprovada');
  const { rows: [m] } = await pool.query("select autor from crm_mensagens_whatsapp where tenant_id = $1 and telefone_e164 = $2 and direcao = 'enviada'", [A, x.conv.telefone_e164]);
  assert.equal(m.autor, 'agente');
  assert.equal((await req('POST', `/crm/api/agente/sugestoes/${x.execucao.id}/enviar`, {})).statusCode, 409); // não envia duas vezes
  assert.equal(enviados.length, 1);
  assert.equal((await req('GET', `/crm/api/agente/conversas/${x.conv.id}`)).json().sugestao, null);
});

test('editar e enviar: decisão "editada", autor humano; texto vazio é recusado', opts, async () => {
  const x = await novaConversa(A, { proposta: 'Texto do agente' });
  assert.equal((await req('POST', `/crm/api/agente/sugestoes/${x.execucao.id}/enviar`, { texto: '   ' })).statusCode, 400);
  enviados.length = 0;
  const r = await req('POST', `/crm/api/agente/sugestoes/${x.execucao.id}/enviar`, { texto: 'Texto ajustado pela equipe' });
  assert.equal(r.json().decisao, 'editada');
  assert.equal(enviados[0].texto, 'Texto ajustado pela equipe');
  const { rows: [m] } = await pool.query("select autor from crm_mensagens_whatsapp where tenant_id = $1 and telefone_e164 = $2 and direcao = 'enviada'", [A, x.conv.telefone_e164]);
  assert.equal(m.autor, 'humano');
});

test('descartar: não envia nada e registra a decisão', opts, async () => {
  const x = await novaConversa(A, { proposta: 'Não quero esse' });
  enviados.length = 0;
  assert.equal((await req('POST', `/crm/api/agente/sugestoes/${x.execucao.id}/descartar`)).statusCode, 200);
  assert.equal(enviados.length, 0);
  const { rows: [e] } = await pool.query('select decisao, resposta_enviada from crm_agente_execucoes where id = $1', [x.execucao.id]);
  assert.deepEqual(e, { decisao: 'descartada', resposta_enviada: null });
});

test('janela de 24 h expirada: não envia e explica', opts, async () => {
  const x = await novaConversa(A, { proposta: 'Oi', janelaHoras: -1 });
  enviados.length = 0;
  const r = await req('POST', `/crm/api/agente/sugestoes/${x.execucao.id}/enviar`, {});
  assert.equal(r.statusCode, 409);
  assert.match(r.json().error, /24 h/);
  assert.equal(enviados.length, 0);
  assert.equal((await req('POST', `/crm/api/agente/conversas/${x.conv.id}/mensagens`, { texto: 'oi' })).statusCode, 409);
});

test('assumir pausa o agente; devolver faz ele voltar', opts, async () => {
  const x = await novaConversa(A, { handoff: 'reclamacao', proposta: 'sugestão antiga' });
  const r = await req('POST', `/crm/api/agente/conversas/${x.conv.id}/assumir`);
  assert.equal(r.json().situacao, 'humano');
  const { rows: [h] } = await pool.query('select status, atribuido_a from crm_handoffs where conversa_id = $1', [x.conv.id]);
  assert.deepEqual(h, { status: 'assumido', atribuido_a: USUARIO });
  const { rows: [e] } = await pool.query('select decisao from crm_agente_execucoes where id = $1', [x.execucao.id]);
  assert.equal(e.decisao, 'descartada'); // sugestão velha não fica pendurada

  let rodou = 0;
  const deps = { executarAgente: async () => { rodou += 1; }, log: () => {} };
  const nova = async (texto) => pool.query("insert into crm_mensagens_whatsapp (tenant_id, telefone_e164, direcao, tipo, conteudo, wamid, autor) values ($1, $2, 'recebida', 'texto', $3, $4, 'cliente')", [A, x.conv.telefone_e164, texto, `w.${crypto.randomUUID()}`]);
  await pool.query("update crm_mensagens_whatsapp set processada_em = now() where tenant_id = $1 and telefone_e164 = $2", [A, x.conv.telefone_e164]);
  await nova('alguém aí?');
  const p1 = await processarConversa(pool, A, x.conv.id, deps);
  assert.equal(p1.pausado, true);
  assert.equal(rodou, 0);

  assert.equal((await req('POST', `/crm/api/agente/conversas/${x.conv.id}/devolver`)).json().situacao, 'bot');
  const { rows: [h2] } = await pool.query('select status from crm_handoffs where conversa_id = $1', [x.conv.id]);
  assert.equal(h2.status, 'resolvido');
  await nova('e agora?');
  await processarConversa(pool, A, x.conv.id, deps);
  assert.equal(rodou, 1);
});

test('equipe responde pelo CRM: envia, assume e o agente pausa', opts, async () => {
  const x = await novaConversa(A, { handoff: 'pedido_humano' });
  enviados.length = 0;
  const r = await req('POST', `/crm/api/agente/conversas/${x.conv.id}/mensagens`, { texto: 'Oi, aqui é a equipe!' });
  assert.equal(r.statusCode, 200);
  assert.equal(enviados[0].texto, 'Oi, aqui é a equipe!');
  const { rows: [c] } = await pool.query('select situacao from crm_conversas_whatsapp where id = $1', [x.conv.id]);
  assert.equal(c.situacao, 'humano');
  const { rows: [m] } = await pool.query("select autor from crm_mensagens_whatsapp where tenant_id = $1 and telefone_e164 = $2 and direcao = 'enviada'", [A, x.conv.telefone_e164]);
  assert.equal(m.autor, 'humano');
});

test('encerrar: conversa encerrada e encaminhamento resolvido', opts, async () => {
  const x = await novaConversa(A, { handoff: 'outro' });
  assert.equal((await req('POST', `/crm/api/agente/conversas/${x.conv.id}/encerrar`)).json().situacao, 'encerrada');
  const { rows: [h] } = await pool.query('select status from crm_handoffs where conversa_id = $1', [x.conv.id]);
  assert.equal(h.status, 'resolvido');
});

test('isolamento: outra conta não vê nem mexe em conversa, sugestão ou anexo', opts, async () => {
  const x = await novaConversa(A, { proposta: 'privado', handoff: 'reclamacao' });
  enviados.length = 0;
  assert.equal((await req('GET', `/crm/api/agente/conversas/${x.conv.id}`, undefined, B)).statusCode, 404);
  assert.equal((await req('POST', `/crm/api/agente/conversas/${x.conv.id}/assumir`, undefined, B)).statusCode, 404);
  assert.equal((await req('POST', `/crm/api/agente/conversas/${x.conv.id}/mensagens`, { texto: 'oi' }, B)).statusCode, 404);
  assert.equal((await req('POST', `/crm/api/agente/sugestoes/${x.execucao.id}/enviar`, {}, B)).statusCode, 404);
  assert.equal((await req('POST', `/crm/api/agente/sugestoes/${x.execucao.id}/descartar`, undefined, B)).statusCode, 404);
  assert.equal(enviados.length, 0);
  const lista = (await req('GET', '/crm/api/agente/conversas', undefined, B)).json();
  assert.ok(!lista.some((c) => c.id === x.conv.id));
  const pn = (await req('GET', '/crm/api/painel-hoje', undefined, B)).json();
  assert.ok(!pn.encaminhamentos.some((e) => e.conversa_id === x.conv.id));
  const { rows: [e] } = await pool.query('select decisao from crm_agente_execucoes where id = $1', [x.execucao.id]);
  assert.equal(e.decisao, null); // nada mudou
});

test('Painel Hoje: encaminhamentos abertos, VIP primeiro, com motivo e tempo de espera', opts, async () => {
  const a = await novaConversa(A, { handoff: 'urgencia' });
  const b = await novaConversa(A, { handoff: 'negociacao_desconto', vip: true });
  const r = await req('GET', '/crm/api/painel-hoje');
  assert.equal(r.statusCode, 200);
  const enc = r.json().encaminhamentos;
  const ia = enc.findIndex((e) => e.conversa_id === a.conv.id);
  const ib = enc.findIndex((e) => e.conversa_id === b.conv.id);
  assert.ok(ib >= 0 && ia >= 0 && ib < ia);
  assert.equal(enc[ib].rotulo, 'Desconto ou negociação');
  assert.equal(typeof enc[ib].minutos_esperando, 'number');
  assert.equal((await req('GET', '/crm/api/agente/resumo')).json().encaminhamentos_abertos >= 2, true);
  await req('POST', `/crm/api/agente/conversas/${a.conv.id}/assumir`);
  const depois = (await req('GET', '/crm/api/painel-hoje')).json().encaminhamentos;
  assert.ok(!depois.some((e) => e.conversa_id === a.conv.id)); // assumido sai da fila de "abertos"
});

test('anexo: baixa só do próprio tenant, com cabeçalhos seguros', opts, async () => {
  const x = await novaConversa(A);
  const { chave } = await app.agente.deps.armazenamento.salvar({ tenantId: A, nomeArquivo: 'peca.stl', buffer: Buffer.from('solid x') });
  const { rows: [a] } = await pool.query(
    "insert into crm_anexos (tenant_id, mensagem_id, chave_armazenamento, nome_arquivo, mime, tamanho) values ($1, $2, $3, 'peca.stl', 'model/stl', 7) returning id", [A, x.msg.id, chave]);
  await pool.query('update crm_mensagens_whatsapp set anexo_id = $2 where id = $1', [x.msg.id, a.id]);
  const ok = await req('GET', `/crm/api/agente/anexos/${a.id}`);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body, 'solid x');
  assert.equal(ok.headers['x-content-type-options'], 'nosniff');
  assert.equal((await req('GET', `/crm/api/agente/anexos/${a.id}`, undefined, B)).statusCode, 404);
  const det = (await req('GET', `/crm/api/agente/conversas/${x.conv.id}`)).json();
  assert.equal(det.mensagens[0].anexo_nome, 'peca.stl');
});

test('chave de liga/desliga: muda o modo, recusa valor inválido e conta sem configuração', opts, async () => {
  assert.equal((await req('GET', '/crm/api/agente/config')).json().modo, 'rascunho');
  assert.equal((await req('PUT', '/crm/api/agente/config', { modo: 'desligado' })).statusCode, 200);
  assert.equal((await req('GET', '/crm/api/agente/config')).json().modo, 'desligado');
  assert.equal((await req('PUT', '/crm/api/agente/config', { modo: 'turbo' })).statusCode, 400);
  const { carregarCanalAtivo } = require('../lib/agente/recebimento');
  assert.equal(await carregarCanalAtivo(pool, `pn-${A.slice(0, 8)}`), null); // desligado: o webhook devolve ao bot antigo
  await req('PUT', '/crm/api/agente/config', { modo: 'rascunho' });
  assert.ok(await carregarCanalAtivo(pool, `pn-${A.slice(0, 8)}`));
  const outra = crypto.randomUUID();
  const sem = await req('PUT', '/crm/api/agente/config', { modo: 'automatico' }, outra);
  assert.equal(sem.statusCode, 409);
  assert.equal((await req('GET', '/crm/api/agente/config', undefined, outra)).json().configurado, false);
});

test('pedido rascunho: marcar como revisado vira pedido normal (só do próprio tenant)', opts, async () => {
  const { rows: [cli] } = await pool.query("insert into crm_clientes (tenant_id, nome) values ($1, 'Rita') returning id", [A]);
  const { rows: [et] } = await pool.query('select id from crm_etapas where tenant_id = $1', [A]);
  const { rows: [p] } = await pool.query(
    "insert into crm_pedidos (tenant_id, cliente_id, etapa_id, origem, numero, rascunho) values ($1, $2, $3, 'WhatsApp', 9001, true) returning id", [A, cli.id, et.id]);
  assert.equal((await req('POST', `/crm/api/pedidos/${p.id}/revisado`, undefined, B)).statusCode, 404);
  assert.equal((await req('POST', `/crm/api/pedidos/${p.id}/revisado`)).statusCode, 200);
  const { rows: [depois] } = await pool.query('select rascunho from crm_pedidos where id = $1', [p.id]);
  assert.equal(depois.rascunho, false);
  assert.equal((await req('POST', `/crm/api/pedidos/${p.id}/revisado`)).statusCode, 404); // já revisado
});
