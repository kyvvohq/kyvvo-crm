const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { provisionarWhatsapp } = require('../lib/provisionamento-whatsapp');

// criarTemplate (do @kyvvohq/whatsapp) cai em modo dev sem META_WHATSAPP_TOKEN
// no ambiente de teste: sempre retorna { ok: false, erro: 'sem credencial' } —
// por isso os testes abaixo focam no que dá pra verificar sem rede de
// verdade: a leitura do catálogo (fetch mockado) e a decisão de criar (ou
// não) a linha de automação quando a Meta aceita o template.

function poolFalso() {
  const automacoesInseridas = [];
  const automacoesExistentes = [];
  return {
    automacoesInseridas,
    query: async (sql, params) => {
      if (/^select 1 from crm_automacoes where tenant_id/.test(sql)) {
        const [tenantId, nome] = params;
        const ja = automacoesExistentes.some((a) => a.tenantId === tenantId && a.nome === nome);
        return { rows: ja ? [{}] : [] };
      }
      if (/^insert into crm_automacoes/.test(sql)) {
        automacoesInseridas.push({ tenantId: params[0], nome: params[1], gatilho: params[2], whatsappTemplate: params[3], corpo: params[4] });
        return { rows: [] };
      }
      throw new Error('query inesperada: ' + sql);
    },
  };
}

afterEach(() => {
  mock.restoreAll();
  delete process.env.ADMIN_INTERNAL_URL;
  delete process.env.ADMIN_INTERNAL_TOKEN;
});

test('sem ADMIN_INTERNAL_URL/TOKEN configurado: não quebra, não insere nada', async () => {
  const pool = poolFalso();
  await provisionarWhatsapp(pool, { tenantId: 't1', wabaId: 'waba1' });
  assert.equal(pool.automacoesInseridas.length, 0);
});

test('catálogo vazio: não insere automação nenhuma', async () => {
  process.env.ADMIN_INTERNAL_URL = 'http://admin:3004';
  process.env.ADMIN_INTERNAL_TOKEN = 'segredo';
  mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ disparos: [] }) }));
  const pool = poolFalso();
  await provisionarWhatsapp(pool, { tenantId: 't1', wabaId: 'waba1' });
  assert.equal(pool.automacoesInseridas.length, 0);
});

test('gatilho fora de GATILHOS_VALIDOS é ignorado', async () => {
  process.env.ADMIN_INTERNAL_URL = 'http://admin:3004';
  process.env.ADMIN_INTERNAL_TOKEN = 'segredo';
  mock.method(global, 'fetch', async () => ({
    ok: true,
    json: async () => ({ disparos: [{ gatilho: 'gatilho_invalido', nome: 'x', categoria: 'UTILITY', corpo: 'Olá {{cliente}}' }] }),
  }));
  const pool = poolFalso();
  await provisionarWhatsapp(pool, { tenantId: 't1', wabaId: 'waba1' });
  assert.equal(pool.automacoesInseridas.length, 0);
});

test('falha ao buscar catálogo (rede fora do ar): não lança, não insere nada', async () => {
  process.env.ADMIN_INTERNAL_URL = 'http://admin:3004';
  process.env.ADMIN_INTERNAL_TOKEN = 'segredo';
  mock.method(global, 'fetch', async () => { throw new Error('ECONNREFUSED'); });
  const pool = poolFalso();
  await assert.doesNotReject(provisionarWhatsapp(pool, { tenantId: 't1', wabaId: 'waba1' }));
  assert.equal(pool.automacoesInseridas.length, 0);
});

test('template criado com sucesso: gatilho sem etapa (ex. aniversario_cliente) ganha automação; gatilho com etapa (pedido_parado) não', async () => {
  process.env.ADMIN_INTERNAL_URL = 'http://admin:3004';
  process.env.ADMIN_INTERNAL_TOKEN = 'segredo';
  process.env.META_WHATSAPP_TOKEN = 'token-fake';
  mock.method(global, 'fetch', async (url) => {
    if (String(url).includes('disparos-catalogo')) {
      return {
        ok: true,
        json: async () => ({
          disparos: [
            { gatilho: 'aniversario_cliente', nome: 'aniversario', categoria: 'MARKETING', corpo: 'Parabéns, {{cliente}}!' },
            { gatilho: 'pedido_parado', nome: 'pedido_parado', categoria: 'UTILITY', corpo: 'Oi {{cliente}}, seu pedido na etapa {{etapa}} está parado há {{dias_parado}} dias.' },
          ],
        }),
      };
    }
    return { ok: true, json: async () => ({ id: 'tpl-123' }) }; // Graph API (criarTemplate)
  });
  const pool = poolFalso();
  try {
    await provisionarWhatsapp(pool, { tenantId: 't1', wabaId: 'waba1' });
  } finally {
    delete process.env.META_WHATSAPP_TOKEN;
  }
  assert.deepEqual(pool.automacoesInseridas.map((a) => a.gatilho), ['aniversario_cliente']);
});
