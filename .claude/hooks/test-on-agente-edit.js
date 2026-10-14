#!/usr/bin/env node
// PostToolUse hook: roda os testes de lib/agente/** automaticamente sempre
// que uma edição tocar esse diretório. Motivo: o bug de produção de
// 2026-10-13 (deps.agora / deps.enviarTexto undefined sobrescrevendo
// defaults via spread em lib/agente/index.js + executor.js) derrubou o
// agente de atendimento inteiro pra TODOS os tenants, e nenhum teste
// cobria o caminho sem overrides. Isso dá feedback ainda na mesma edição,
// em vez de esperar o CI.
//
// Roda só test/agente-*.test.js (não `npm test` inteiro) de propósito:
// test/smoke.test.js tem uma falha pré-existente e conhecida neste
// ambiente local (ECONNREFUSED :5432 — sem Postgres local, ver
// feedback_run_real_tests_not_just_syntax_check) que não tem nada a ver
// com o agente e só geraria ruído a cada edição. Os testes de
// test/agente-*.test.js que precisam de DB já se auto-pulam de forma
// limpa quando DATABASE_URL não está setado ("# sem DATABASE_URL") — não
// é um falso positivo, é comportamento esperado.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function lerEntrada() {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  return new Promise((resolve) => {
    process.stdin.on('end', () => {
      // strip BOM: alguns shells (PowerShell `echo |`, entre outros) prefixam
      // o stdin com ﻿, o que quebra JSON.parse silenciosamente.
      const texto = Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '');
      try {
        resolve(JSON.parse(texto || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

(async () => {
  const entrada = await lerEntrada();
  const toolInput = entrada.tool_input || {};
  const arquivo = toolInput.file_path || '';
  const normalizado = arquivo.split(path.sep).join('/');

  if (!normalizado.includes('lib/agente/')) {
    process.exit(0); // não é arquivo do agente — nada a fazer
  }

  // raiz do projeto = dois níveis acima deste arquivo (<root>/.claude/hooks/...)
  const root = path.resolve(__dirname, '..', '..');
  const testDir = path.join(root, 'test');
  let arquivosDeTeste = [];
  try {
    arquivosDeTeste = fs
      .readdirSync(testDir)
      .filter((f) => /^agente-.*\.test\.js$/.test(f))
      .map((f) => path.join('test', f));
  } catch {
    // sem diretório test/ — nada a rodar
  }

  if (arquivosDeTeste.length === 0) {
    process.stdout.write('[test-on-agente-edit] nenhum test/agente-*.test.js encontrado — pulando.\n');
    process.exit(0);
  }

  try {
    execFileSync('node', ['--test', ...arquivosDeTeste], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    process.stdout.write(
      `[test-on-agente-edit] ${arquivosDeTeste.length} arquivo(s) de teste do agente passaram após editar ${arquivo}\n`,
    );
    process.exit(0);
  } catch (erro) {
    const detalhe = [erro.stdout, erro.stderr].filter(Boolean).join('\n');
    process.stderr.write(
      `[test-on-agente-edit] testes de lib/agente/ FALHARAM após editar ${arquivo} (arquivo sensível: já causou incidente de produção quando quebrado sem teste cobrindo).\n\n${detalhe}\n`,
    );
    process.exit(2); // exit 2 = feedback vai pro Claude revisar/corrigir
  }
})();
