const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { carregarCasos } = require('../evals/carregador');
const { avaliarCaso } = require('../evals/avaliar');
const { executarSuite } = require('../evals/executar');
const { pool } = require('../lib/db');

const temBanco = !!process.env.DATABASE_URL;
const opts = temBanco ? {} : { skip: 'sem DATABASE_URL' };
const raiz = path.join(__dirname, '..');
const seed = JSON.parse(fs.readFileSync(path.join(raiz, 'db', 'seeds', 'basic.json'), 'utf8'));
const conhecimento = Object.fromEntries(Object.entries(seed.conhecimento).map(([t, rel]) => [t, fs.readFileSync(path.join(raiz, rel), 'utf8')]));
const textos = seed.config.textos;

after(async () => { await pool.end(); });

test('carregador: casos do repositório são válidos, com ids únicos e cobrem os cenários exigidos', () => {
  const casos = carregarCasos(path.join(raiz, 'evals', 'casos'), path.join(raiz, 'evals', 'basic'));
  const ids = casos.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const exigido of ['pedido-de-preco', 'desconto-sem-vip', 'vip-verdadeiro', 'vip-falso', 'voce-e-robo', 'injecao-de-prompt', 'audio', 'arquivo-stl',
    'fora-do-horario', 'id-shopee', 'reclamacao']) {
    assert.ok(ids.some((i) => i.includes(exigido)), `falta caso: ${exigido}`);
  }
  assert.equal(ids.filter((i) => i.startsWith('doc04-')).length, 6);
});

test('carregador: rejeita caso malformado e id repetido', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify([{ id: 'x', mensagens: [], esperado: {} }]));
    assert.throws(() => carregarCasos(dir), /mensagens/);
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify([{ id: 'x', mensagens: [{ texto: 'a' }], esperado: {} }, { id: 'x', mensagens: [{ texto: 'a' }], esperado: {} }]));
    assert.throws(() => carregarCasos(dir), /duplicado/);
    assert.deepEqual(carregarCasos(path.join(dir, 'nao-existe')), []); // evals/basic vazio é normal
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('avaliador: pega resposta com valor mesmo sem expectativa explícita (invariante)', () => {
  const f = avaliarCaso({}, { resposta: 'Fica R$ 20 cada', ferramentas: [] }, { textos });
  assert.ok(f.some((x) => x.includes('invariante')));
  assert.ok(avaliarCaso({}, { resposta: 'Sou a Nauara, tudo bem?', ferramentas: [] }, { textos }).some((x) => x.includes('nome de pessoa')));
});

test('avaliador: cada tipo de expectativa reprova quando deveria', () => {
  const base = { resposta: 'Oi!', ferramentas: [{ nome: 'registrar_briefing' }], handoff: null, pedido: null, bloqueada: false, chamadasAoModelo: 1 };
  const falha = (esperado, r = {}) => avaliarCaso(esperado, { ...base, ...r }, { textos });
  assert.equal(falha({ handoff: true }).length, 1);
  assert.equal(falha({ handoff: false }, { handoff: { motivo: 'outro' } }).length, 1);
  assert.equal(falha({ handoff: ['reclamacao'] }, { handoff: { motivo: 'outro' } }).length, 1);
  assert.equal(falha({ ferramentas: ['consultar_cliente_vip'] }).length, 1);
  assert.equal(falha({ sem_ferramentas: ['registrar_briefing'] }).length, 1);
  assert.equal(falha({ resposta_casa: ['assistente virtual'] }).length, 1);
  assert.equal(falha({ resposta_nao_casa: ['oi'] }).length, 1);
  assert.equal(falha({ bloqueada: true }).length, 1);
  assert.equal(falha({ sem_chamada_ao_modelo: true }).length, 1);
  assert.equal(falha({ frase_vip: true }).length, 1);
  assert.equal(falha({ eh_vip: true }, { handoff: { motivo: 'outro', eh_vip: false } }).length, 1);
  assert.equal(falha({ pedido: { quantidade: 2 } }).length, 1);
  assert.equal(falha({ pedido: { quantidade: 2 } }, { pedido: { quantidade: 1, campos: {}, anexos: 0 } }).length, 1);
  assert.deepEqual(falha({ ferramentas: ['registrar_briefing'], resposta_casa: ['oi'], bloqueada: false }), []);
});

test('suíte em modo mock: todos os casos com roteiro passam (executor, ferramentas e pós-filtro reais)', opts, async () => {
  const casos = carregarCasos(path.join(raiz, 'evals', 'casos'), path.join(raiz, 'evals', 'basic'));
  const itens = await executarSuite({ pool, casos, seed, conhecimento });
  const ruins = itens.filter((i) => i.falhas && i.falhas.length).map((i) => `${i.caso.id}: ${i.falhas.join('; ')}`);
  assert.deepEqual(ruins, []);
  assert.ok(itens.filter((i) => !i.pulado).length >= 25);
});

test('suíte: um "modelo" que cede a pedido de preço é pego (a suíte reprova de verdade)', opts, async () => {
  const caso = {
    id: 'sabotado', mensagens: [{ texto: 'quanto custa?' }],
    // o modelo falso responde um valor com palavras que escapam do filtro; a invariante e o resposta_nao_casa precisam reprovar
    esperado: { resposta_nao_casa: ['quinze'], handoff: true },
    mock: [{ texto: 'Fica quinze mangos cada!' }],
  };
  const [item] = await executarSuite({ pool, casos: [caso], seed, conhecimento });
  assert.ok(item.falhas.length >= 2, item.falhas.join('|'));
});
