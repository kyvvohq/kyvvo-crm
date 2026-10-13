// Armazenamento de anexos do agente. Interface única (salvar/ler) para poder
// trocar o disco por S3 depois sem tocar no resto: hoje só o driver de disco
// (decisão de 2026-09-24 de não abrir infra externa, ver lib/whatsapp-media.js).
// Toda chave começa com o tenant_id e leitura exige o tenant: um tenant nunca
// alcança arquivo de outro, nem com chave forjada.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function nomeSeguro(nome) {
  const base = path.basename(String(nome || 'arquivo')).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  return base && base !== '.' && base !== '..' ? base : 'arquivo';
}

function criarArmazenamentoDisco(dirBase) {
  const raiz = path.resolve(dirBase);

  function resolver(tenantId, chave) {
    if (!tenantId || !chave || !String(chave).startsWith(`${tenantId}/`)) throw new Error('chave fora do tenant');
    const abs = path.resolve(raiz, chave);
    if (!abs.startsWith(path.join(raiz, tenantId) + path.sep)) throw new Error('chave inválida');
    return abs;
  }

  return {
    async salvar({ tenantId, nomeArquivo, buffer }) {
      if (!tenantId) throw new Error('tenantId obrigatório');
      const hoje = new Date().toISOString().slice(0, 10);
      const chave = `${tenantId}/${hoje}/${crypto.randomUUID()}-${nomeSeguro(nomeArquivo)}`;
      const abs = resolver(tenantId, chave);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, buffer);
      return { chave };
    },
    async ler(tenantId, chave) {
      return fs.promises.readFile(resolver(tenantId, chave));
    },
  };
}

module.exports = { criarArmazenamentoDisco, nomeSeguro };
