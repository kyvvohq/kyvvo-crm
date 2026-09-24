const { test } = require('node:test');
const assert = require('node:assert/strict');
const { processarMensagem, SAUDACAO_TEXTO, SAUDACAO_BOTOES, PERGUNTAS } = require('../lib/bot-whatsapp');

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
const texto = (t) => ({ tipo: 'texto', texto: t });
const botao = (id) => ({ tipo: 'botao', id });
const arquivo = (nomeArquivo, mediaId = 'media-1') => ({ tipo: 'arquivo', mediaId, nomeArquivo });

test('primeira mensagem: manda a saudação com botões e cria conversa em aguardando_opcao', async () => {
  const { pool, conversas } = poolFalso();
  const envios = await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, entrada: texto('oi') });
  assert.deepEqual(envios, [{ tipo: 'botoes', texto: SAUDACAO_TEXTO, botoes: SAUDACAO_BOTOES }]);
  assert.equal(conversas.get(`${TENANT}|${TELEFONE}`).estado, 'aguardando_opcao');
});

test('botão "ver_lojas": manda o texto das lojas e encerra a conversa', async () => {
  const { pool, conversas, pedidos } = poolFalso();
  await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, entrada: texto('oi') });
  const envios = await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, entrada: botao('ver_lojas') });
  assert.equal(envios.length, 1);
  assert.equal(envios[0].tipo, 'texto');
  assert.ok(envios[0].texto.includes('Shopee'));
  assert.equal(conversas.has(`${TENANT}|${TELEFONE}`), false);
  assert.equal(pedidos.length, 0);
});

test('entrada inesperada em aguardando_opcao: reenvia os mesmos botões', async () => {
  const { pool, conversas } = poolFalso();
  await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, entrada: texto('oi') });
  const envios = await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, entrada: texto('blabla') });
  assert.deepEqual(envios, [{ tipo: 'botoes', texto: SAUDACAO_TEXTO, botoes: SAUDACAO_BOTOES }]);
  assert.equal(conversas.get(`${TENANT}|${TELEFONE}`).estado, 'aguardando_opcao');
});

test('botão "fazer_pedido" -> "sem_arquivo": percorre as 7 perguntas e cria cliente + pedido', async () => {
  const { pool, conversas, clientes, pedidos, itens } = poolFalso();
  await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, entrada: texto('oi') });
  await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, entrada: botao('fazer_pedido') });
  await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, entrada: botao('sem_arquivo') });

  const valores = ['Vaso', '15', '20', '15', 'redondo', 'sem borda', 'azul'];
  let ultimoEnvio;
  for (const valor of valores) {
    [ultimoEnvio] = await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, entrada: texto(valor) });
  }

  assert.equal(ultimoEnvio.tipo, 'texto');
  assert.ok(ultimoEnvio.texto.includes('Vaso'));
  assert.ok(ultimoEnvio.texto.includes('15 x 20 x 15 cm'));
  assert.equal(conversas.has(`${TENANT}|${TELEFONE}`), false);
  assert.equal(clientes.size, 1);
  assert.equal(pedidos.length, 1);
  assert.equal(itens[0].descricao, 'Vaso — 15x20x15cm, formato redondo, sem borda, cor azul');
});

test('botão "fazer_pedido" -> "tem_arquivo": pede o arquivo, depois cor e quantidade, cria pedido', async () => {
  const { pool, conversas, clientes, pedidos, itens } = poolFalso();
  await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, entrada: texto('oi') });
  await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, entrada: botao('fazer_pedido') });
  const [pedeArquivo] = await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, entrada: botao('tem_arquivo') });
  assert.ok(pedeArquivo.texto.includes('mandar o arquivo'));

  const [pedeCor] = await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, entrada: arquivo('peca.stl') });
  assert.ok(pedeCor.texto.includes('cor'));

  const [pedeQuantidade] = await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, entrada: texto('vermelho') });
  assert.ok(pedeQuantidade.texto.includes('quantidade'));

  const [confirmacao] = await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, entrada: texto('3') });
  assert.ok(confirmacao.texto.includes('peca.stl'));
  assert.ok(confirmacao.texto.includes('vermelho'));
  assert.ok(confirmacao.texto.includes('3'));

  assert.equal(conversas.has(`${TENANT}|${TELEFONE}`), false);
  assert.equal(clientes.size, 1);
  assert.equal(pedidos.length, 1);
  assert.equal(itens[0].descricao, 'Arquivo: peca.stl — cor vermelho, quantidade 3');
});

test('aguardando arquivo: texto solto não avança, pede o arquivo de novo', async () => {
  const { pool, conversas } = poolFalso();
  await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, entrada: texto('oi') });
  await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, entrada: botao('fazer_pedido') });
  await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, entrada: botao('tem_arquivo') });
  const [envio] = await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, entrada: texto('oi de novo') });
  assert.ok(envio.texto.includes('Ainda não recebi'));
  assert.equal(conversas.get(`${TENANT}|${TELEFONE}`).estado, 'aguardando_envio_arquivo');
});

test('fluxo sem arquivo sem etapa configurada: ainda responde ao cliente, mas não cria pedido', async () => {
  const { pool, pedidos } = poolFalso({ semEtapa: true });
  await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, entrada: texto('oi') });
  await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, entrada: botao('fazer_pedido') });
  await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, entrada: botao('sem_arquivo') });
  let ultimoEnvio;
  for (const valor of ['Vaso', '15', '20', '15', 'redondo', 'sem borda', 'azul']) {
    [ultimoEnvio] = await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, entrada: texto(valor) });
  }
  assert.ok(ultimoEnvio.texto.includes('Já registrei seu pedido'));
  assert.equal(pedidos.length, 0);
});

test('PERGUNTAS: 7 perguntas na ordem do briefing (tipo, largura, altura, comprimento, formato, borda, cor)', () => {
  assert.deepEqual(PERGUNTAS.map((p) => p.chave), ['tipo_peca', 'largura', 'altura', 'comprimento', 'formato', 'borda', 'cor']);
});
