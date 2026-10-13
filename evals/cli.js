// Suíte de evals do agente.
//
//   npm run evals                          modo mock (sem rede, sem custo) — valida a suíte e os guardrails
//   npm run evals -- --real                modelo real da config (precisa de ANTHROPIC_API_KEY; gasta tokens)
//   npm run evals -- --real --modelos claude-haiku-4-5,claude-haiku-5-5
//   npm run evals -- --casos adv-audio,adv-id-shopee   só estes casos
//
// Usa um tenant descartável no banco de DATABASE_URL e o apaga no fim. Por
// segurança recusa bancos que não sejam locais (EVALS_PERMITIR_BANCO_REMOTO=1 libera).
// A API em lote (Batch) não serve aqui: cada caso é um laço de ferramentas com
// várias idas e voltas ao modelo, e a suíte é pequena.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { carregarCasos } = require('./carregador');
const { executarSuite } = require('./executar');

// US$ por 1M de tokens (entrada, saída) — tabela de preços vigente em 2026-10; conferir antes de decidir por custo.
const PRECOS = { 'claude-haiku-4-5': [1.0, 5.0], 'claude-haiku-5-5': [0.1, 0.5] };

function args() {
  const o = { real: false, modelos: null, casos: null };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === '--real') o.real = true;
    else if (a[i] === '--modelos') o.modelos = a[(i += 1)].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a[i] === '--casos') o.casos = a[(i += 1)].split(',').map((s) => s.trim()).filter(Boolean);
    else throw new Error(`argumento desconhecido: ${a[i]}`);
  }
  return o;
}

function resumir(itens) {
  const porModelo = new Map();
  for (const it of itens) {
    if (!porModelo.has(it.modelo)) porModelo.set(it.modelo, { modelo: it.modelo, rodados: 0, ok: 0, pulados: 0, bloqueios: 0, handoffs: 0, tin: 0, tout: 0, latencia: 0 });
    const m = porModelo.get(it.modelo);
    if (it.pulado) { m.pulados += 1; continue; }
    m.rodados += 1;
    if (it.falhas.length === 0) m.ok += 1;
    if (it.resultado) {
      if (it.resultado.bloqueada) m.bloqueios += 1;
      if (it.resultado.handoff) m.handoffs += 1;
      m.tin += it.resultado.tokens.in; m.tout += it.resultado.tokens.out; m.latencia += it.resultado.latenciaMs;
    }
  }
  return [...porModelo.values()].map((m) => {
    const p = PRECOS[m.modelo];
    return { ...m, custo: p ? (m.tin * p[0] + m.tout * p[1]) / 1e6 : null, latMedia: m.rodados ? Math.round(m.latencia / m.rodados) : 0 };
  });
}

function relatorio(itens, real) {
  const linhas = [`# Evals do agente — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} (${real ? 'modelo REAL' : 'mock'})`, ''];
  linhas.push('| Modelo | Casos | Passaram | Filtro acionado | Encaminhados | Tokens (ent/saí) | Latência média | Custo US$ |');
  linhas.push('|---|---|---|---|---|---|---|---|');
  for (const m of resumir(itens)) {
    linhas.push(`| ${m.modelo} | ${m.rodados} | ${m.ok} (${m.rodados ? Math.round((100 * m.ok) / m.rodados) : 0}%) | ${m.bloqueios} | ${m.handoffs} | ${m.tin}/${m.tout} | ${m.latMedia} ms | ${m.custo === null ? 'n/d' : m.custo.toFixed(4)} |`);
  }
  const falhos = itens.filter((i) => i.falhas && i.falhas.length);
  if (falhos.length) {
    linhas.push('', '## Falhas', '');
    for (const f of falhos) {
      linhas.push(`### ${f.caso.id} (${f.modelo})`, `_${f.caso.descricao || ''}_`);
      for (const x of f.falhas) linhas.push(`- ${x}`);
      if (f.resultado) linhas.push(`- resposta: ${JSON.stringify(f.resultado.resposta)}`);
      if (f.resultado && f.resultado.bloqueada) linhas.push(`- texto original do modelo (bloqueado: ${f.resultado.motivoBloqueio}): ${JSON.stringify(f.resultado.original)}`);
      linhas.push('');
    }
  }
  const bloqueados = itens.filter((i) => i.resultado && i.resultado.bloqueada);
  if (bloqueados.length) {
    linhas.push('', '## Respostas bloqueadas pelo filtro', '');
    for (const b of bloqueados) linhas.push(`- ${b.caso.id} (${b.modelo}) [${b.resultado.motivoBloqueio}]: ${JSON.stringify(b.resultado.original)}`);
  }
  const pulados = itens.filter((i) => i.pulado);
  if (pulados.length) linhas.push('', `Pulados: ${[...new Set(pulados.map((p) => `${p.caso.id} (${p.pulado})`))].join('; ')}`);
  return linhas.join('\n');
}

(async () => {
  const o = args();
  const url = process.env.DATABASE_URL || '';
  if (!url) throw new Error('DATABASE_URL obrigatório (use um banco local descartável)');
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url) && process.env.EVALS_PERMITIR_BANCO_REMOTO !== '1') {
    throw new Error('DATABASE_URL não é local; os evals criam e apagam dados. EVALS_PERMITIR_BANCO_REMOTO=1 para liberar.');
  }
  if (o.real && !process.env.ANTHROPIC_API_KEY) throw new Error('--real precisa de ANTHROPIC_API_KEY');

  const { pool, migrar } = require('../lib/db');
  await migrar();
  const raiz = path.join(__dirname, '..');
  const seed = JSON.parse(fs.readFileSync(path.join(raiz, 'db', 'seeds', 'basic.json'), 'utf8'));
  const conhecimento = Object.fromEntries(Object.entries(seed.conhecimento).map(([t, rel]) => [t, fs.readFileSync(path.join(raiz, rel), 'utf8')]));

  let casos = carregarCasos(path.join(__dirname, 'casos'), path.join(__dirname, 'basic'));
  if (o.casos) casos = casos.filter((c) => o.casos.includes(c.id));
  if (!casos.length) throw new Error('nenhum caso selecionado');

  const modelos = o.real ? (o.modelos || [seed.config.modelo_runtime]) : [null];
  console.log(`${casos.length} casos, ${o.real ? `modelos: ${modelos.join(', ')}` : 'modo mock'}`);
  const itens = await executarSuite({
    pool, casos, modelos, real: o.real, seed, conhecimento,
    onCaso: (it) => console.log(`${it.falhas.length ? 'FALHOU' : 'ok    '} ${it.modelo} ${it.caso.id}${it.falhas.length ? ` — ${it.falhas[0]}` : ''}`),
  });
  await pool.end();

  const md = relatorio(itens, o.real);
  const dir = path.join(__dirname, 'resultados');
  fs.mkdirSync(dir, { recursive: true });
  const arq = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${o.real ? 'real' : 'mock'}.md`);
  fs.writeFileSync(arq, md);
  console.log(`\n${md}\n\nrelatório: ${arq}`);
  process.exit(itens.some((i) => i.falhas && i.falhas.length) ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
