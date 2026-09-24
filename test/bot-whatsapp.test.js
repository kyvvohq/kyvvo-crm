const { test } = require('node:test');
const assert = require('node:assert/strict');
const { processarMensagem, SAUDACAO, PERGUNTAS } = require('../lib/bot-whatsapp');

function poolFalso({ semEtapa } = {}) {
  const conversas = new Map();
  const clientes = new Map();
  const pedidos = [];
  const itens = [];
  const eventos = [];
  const key = (t, tel) => `${t}|${tel}`;

  const pool = {
    query: async (sql, params) => {
      if (/^select \* from crm_conversas_whatsapp/.test(sql)) {
        const [tenantId, telefone] = params;
        const row = conversas.get(key(tenantId, telefone));
        return { rows: row ? [row] : [] };
      }
      if (/^insert into crm_conversas_whatsapp/.test(sql)) {
        const [tenantId, telefone, estado, respostas] = params;
        conversas.set(key(tenantId, telefone), { tenant_id: tenantId, telefone_e164: telefone, estado, respostas: JSON.parse(respostas) });
        return { rows: [] };
      }
      if (/^delete from crm_conversas_whatsapp/.test(sql)) {
        const [tenantId, telefone] = params;
        conversas.delete(key(tenantId, telefone));
        return { rows: [] };
      }
      if (/^select id from crm_etapas/.test(sql)) {
        return { rows: semEtapa ? [] : [{ id: 'etapa-1' }] };
      }
      if (/^select \* from crm_clientes where tenant_id = \$1 and telefone = \$2/.test(sql)) {
        const [, telefone] = params;
        const c = clientes.get(telefone);
        return { rows: c ? [c] : [] };
      }
      if (/^insert into crm_clientes \(tenant_id, nome, telefone, origem\)/.test(sql)) {
        const [tenantId, nome, telefone, origem] = params;
        const cliente = { id: `cliente-${clientes.size + 1}`, tenant_id: tenantId, nome, telefone, origem };
        clientes.set(telefone, cliente);
        return { rows: [cliente] };
      }
      throw new Error('query inesperada: ' + sql);
    },
    connect: async () => ({
      query: async (sql, params) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
        if (/^insert into crm_pedidos \(/.test(sql)) {
          const pedido = { id: `pedido-${pedidos.length + 1}`, tenant_id: params[0], cliente_id: params[1], etapa_id: params[2] };
          pedidos.push(pedido);
          return { rows: [pedido] };
        }
        if (/^insert into crm_pedidos_itens/.test(sql)) {
          itens.push({ pedidoId: params[0], descricao: params[1] });
          return { rows: [] };
        }
        if (/^insert into crm_eventos/.test(sql)) {
          eventos.push({ params });
          return { rows: [] };
        }
        throw new Error('query inesperada (client): ' + sql);
      },
      release: () => {},
    }),
  };
  return { pool, conversas, clientes, pedidos, itens, eventos };
}

const TENANT = 'tenant-basic';
const TELEFONE = '+5534999998888';

test('primeira mensagem: manda a saudação e cria conversa em aguardando_opcao', async () => {
  const { pool, conversas } = poolFalso();
  const respostas = await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, texto: 'oi' });
  assert.deepEqual(respostas, [SAUDACAO]);
  assert.equal(conversas.get(`${TENANT}|${TELEFONE}`).estado, 'aguardando_opcao');
});

test('opção 2: agradece e encerra a conversa (sem criar pedido)', async () => {
  const { pool, conversas, pedidos } = poolFalso();
  await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, texto: 'oi' });
  const respostas = await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, texto: '2️⃣' });
  assert.ok(respostas[0].includes('Que bom que você já encontrou'));
  assert.equal(conversas.has(`${TENANT}|${TELEFONE}`), false);
  assert.equal(pedidos.length, 0);
});

test('opção inválida: pede pra responder 1 ou 2, sem sair de aguardando_opcao', async () => {
  const { pool, conversas } = poolFalso();
  await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, texto: 'oi' });
  const respostas = await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, texto: 'blabla' });
  assert.ok(respostas[0].includes('Não entendi'));
  assert.equal(conversas.get(`${TENANT}|${TELEFONE}`).estado, 'aguardando_opcao');
});

test('opção 1: percorre as 7 perguntas e cria cliente + pedido no fim', async () => {
  const { pool, conversas, clientes, pedidos, itens } = poolFalso();
  await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, texto: 'oi' });
  await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, texto: '1️⃣' });

  const valores = ['Vaso', '15', '20', '15', 'redondo', 'sem borda', 'azul'];
  let ultimaResposta;
  for (const valor of valores) {
    ultimaResposta = await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, texto: valor });
  }

  assert.equal(ultimaResposta.length, 1);
  assert.ok(ultimaResposta[0].includes('Vaso'));
  assert.ok(ultimaResposta[0].includes('15 x 20 x 15 cm'));
  assert.equal(conversas.has(`${TENANT}|${TELEFONE}`), false, 'conversa deve ser encerrada ao final');
  assert.equal(clientes.size, 1);
  assert.equal(pedidos.length, 1);
  assert.equal(itens.length, 1);
  assert.equal(itens[0].descricao, 'Vaso — 15x20x15cm, formato redondo, sem borda, cor azul');
});

test('opção 1 sem etapa configurada: ainda responde ao cliente, mas não cria pedido', async () => {
  const { pool, pedidos } = poolFalso({ semEtapa: true });
  await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, texto: 'oi' });
  await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, texto: '1' });
  let ultimaResposta;
  for (const valor of ['Vaso', '15', '20', '15', 'redondo', 'sem borda', 'azul']) {
    ultimaResposta = await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, texto: valor });
  }
  assert.ok(ultimaResposta[0].includes('Já registrei seu pedido'));
  assert.equal(pedidos.length, 0);
});

test('PERGUNTAS: 7 perguntas na ordem do briefing (tipo, largura, altura, comprimento, formato, borda, cor)', () => {
  assert.deepEqual(PERGUNTAS.map((p) => p.chave), ['tipo_peca', 'largura', 'altura', 'comprimento', 'formato', 'borda', 'cor']);
});
