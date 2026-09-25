const { test } = require('node:test');
const assert = require('node:assert/strict');
const { processarMensagem, SAUDACAO_TEXTO, SAUDACAO_BOTOES } = require('../lib/bot-whatsapp');

function poolFalso({ semEtapa, clienteExistente } = {}) {
  const conversas = new Map();
  const clientes = new Map();
  const pedidos = [];
  const itens = [];
  const arquivosPedido = [];
  const eventos = [];
  const key = (t, tel) => `${t}|${tel}`;

  if (clienteExistente) clientes.set(clienteExistente.telefone, clienteExistente);

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
      if (/^select cep, numero from crm_clientes/.test(sql)) {
        const [, telefone] = params;
        const c = clientes.get(telefone);
        return { rows: c ? [{ cep: c.cep || null, numero: c.numero || null }] : [] };
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
      if (/^update crm_clientes set cep = \$1, numero = \$2, complemento = \$3/.test(sql)) {
        const [cep, numero, complemento, clienteId] = params;
        for (const c of clientes.values()) if (c.id === clienteId) Object.assign(c, { cep, numero, complemento });
        return { rows: [] };
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
          itens.push({ pedidoId: params[0], descricao: params[1], quantidade: params[2] });
          return { rows: [] };
        }
        if (/^insert into crm_pedidos_arquivos/.test(sql)) {
          arquivosPedido.push({ pedidoId: params[0], nomeArquivo: params[1], caminhoArquivo: params[2], tipoMime: params[3], mediaId: params[4] });
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
  return { pool, conversas, clientes, pedidos, itens, arquivosPedido, eventos };
}

const TENANT = 'tenant-basic';
const TELEFONE = '+5534999998888';
const texto = (t) => ({ tipo: 'texto', texto: t });
const botao = (id) => ({ tipo: 'botao', id });
const arquivo = (nomeArquivo, mediaId = 'media-1') => ({ tipo: 'arquivo', mediaId, nomeArquivo });
const baixarMidiaFalso = async (mediaId, { nomeArquivoSugerido }) => ({
  caminhoArquivo: `2026-09-24/${mediaId}-${nomeArquivoSugerido || 'arquivo.bin'}`,
  nomeArquivo: nomeArquivoSugerido || `${mediaId}.bin`,
  tipoMime: 'application/octet-stream',
});
const enviar = (pool, tenantId, telefoneE164, entrada, extra = {}) => processarMensagem(pool, { tenantId, telefoneE164, entrada, baixarMidia: baixarMidiaFalso, ...extra });

test('primeira mensagem: manda a saudação com botões e cria conversa em aguardando_opcao', async () => {
  const { pool, conversas } = poolFalso();
  const envios = await enviar(pool, TENANT, TELEFONE, texto('oi'));
  assert.deepEqual(envios, [{ tipo: 'botoes', texto: SAUDACAO_TEXTO, botoes: SAUDACAO_BOTOES }]);
  assert.equal(conversas.get(`${TENANT}|${TELEFONE}`).estado, 'aguardando_opcao');
});

test('botão "ver_lojas": manda o texto das lojas e encerra a conversa', async () => {
  const { pool, conversas, pedidos } = poolFalso();
  await enviar(pool, TENANT, TELEFONE, texto('oi'));
  const envios = await enviar(pool, TENANT, TELEFONE, botao('ver_lojas'));
  assert.equal(envios.length, 1);
  assert.ok(envios[0].texto.includes('Shopee'));
  assert.equal(conversas.has(`${TENANT}|${TELEFONE}`), false);
  assert.equal(pedidos.length, 0);
});

test('entrada inesperada em aguardando_opcao: reenvia os mesmos botões', async () => {
  const { pool, conversas } = poolFalso();
  await enviar(pool, TENANT, TELEFONE, texto('oi'));
  const envios = await enviar(pool, TENANT, TELEFONE, texto('blabla'));
  assert.deepEqual(envios, [{ tipo: 'botoes', texto: SAUDACAO_TEXTO, botoes: SAUDACAO_BOTOES }]);
  assert.equal(conversas.get(`${TENANT}|${TELEFONE}`).estado, 'aguardando_opcao');
});

test('fluxo com arquivo: vários arquivos, cor, quantidade validada, endereço e criação do pedido', async () => {
  const { pool, conversas, clientes, pedidos, itens, arquivosPedido } = poolFalso();
  await enviar(pool, TENANT, TELEFONE, texto('oi'), { nomeWhatsapp: 'Maria da Silva' });
  await enviar(pool, TENANT, TELEFONE, botao('fazer_pedido'));
  await enviar(pool, TENANT, TELEFONE, botao('tem_arquivo'));

  await enviar(pool, TENANT, TELEFONE, arquivo('peca.stl'));
  await enviar(pool, TENANT, TELEFONE, arquivo('foto-referencia.png'));
  const [pedeCor] = await enviar(pool, TENANT, TELEFONE, texto('pronto'));
  assert.ok(pedeCor.texto.includes('cor'));

  const [pedeQuantidade] = await enviar(pool, TENANT, TELEFONE, texto('vermelho'));
  assert.ok(pedeQuantidade.texto.includes('peças'));

  const [invalida] = await enviar(pool, TENANT, TELEFONE, texto('umas três'));
  assert.ok(invalida.texto.includes('inteiro de pelo menos 1'));

  const [pedeCep] = await enviar(pool, TENANT, TELEFONE, texto('3'));
  assert.ok(pedeCep.texto.includes('CEP'));
  const [pedeNumero] = await enviar(pool, TENANT, TELEFONE, texto('01310-000'));
  assert.ok(pedeNumero.texto.includes('número'));
  const [pedeComplemento] = await enviar(pool, TENANT, TELEFONE, texto('123'));
  assert.ok(pedeComplemento.texto.includes('complemento'));
  // Meta manda o nome do perfil em toda mensagem, não só na primeira — o
  // webhook real (index.js) sempre repassa o valor mais recente.
  const [confirmacao] = await enviar(pool, TENANT, TELEFONE, texto('não'), { nomeWhatsapp: 'Maria da Silva' });

  assert.ok(confirmacao.texto.includes('peca.stl'));
  assert.ok(confirmacao.texto.includes('foto-referencia.png'));
  assert.ok(confirmacao.texto.includes('vermelho'));
  assert.ok(confirmacao.texto.includes('3'));
  assert.ok(confirmacao.texto.includes('01310-000'));

  assert.equal(conversas.has(`${TENANT}|${TELEFONE}`), false);
  assert.equal(clientes.get(TELEFONE).nome, 'Maria da Silva');
  assert.equal(clientes.get(TELEFONE).cep, '01310-000');
  assert.equal(clientes.get(TELEFONE).numero, '123');
  assert.equal(clientes.get(TELEFONE).complemento, null);
  assert.equal(pedidos.length, 1);
  assert.equal(itens[0].quantidade, 3);
  assert.equal(arquivosPedido.length, 2);
});

test('fluxo sem arquivo: referência em texto, quantidade e endereço', async () => {
  const { pool, pedidos, itens, arquivosPedido } = poolFalso();
  await enviar(pool, TENANT, TELEFONE, texto('oi'));
  await enviar(pool, TENANT, TELEFONE, botao('fazer_pedido'));
  const [pedeReferencia] = await enviar(pool, TENANT, TELEFONE, botao('sem_arquivo'));
  assert.ok(pedeReferencia.texto.includes('referência'));

  await enviar(pool, TENANT, TELEFONE, texto('Um vaso parecido com o modelo X do Pinterest'));
  await enviar(pool, TENANT, TELEFONE, texto('2'));
  await enviar(pool, TENANT, TELEFONE, texto('01310-000'));
  await enviar(pool, TENANT, TELEFONE, texto('50'));
  const [confirmacao] = await enviar(pool, TENANT, TELEFONE, texto('casa 2'));

  assert.ok(confirmacao.texto.includes('Pinterest'));
  assert.ok(confirmacao.texto.includes('casa 2'));
  assert.equal(pedidos.length, 1);
  assert.equal(itens[0].quantidade, 2);
  assert.equal(arquivosPedido.length, 0);
});

test('fluxo sem arquivo: referência enviada como foto (arquivo) também é aceita', async () => {
  const { pool, arquivosPedido } = poolFalso();
  await enviar(pool, TENANT, TELEFONE, texto('oi'));
  await enviar(pool, TENANT, TELEFONE, botao('fazer_pedido'));
  await enviar(pool, TENANT, TELEFONE, botao('sem_arquivo'));
  await enviar(pool, TENANT, TELEFONE, arquivo('foto.jpg'));
  await enviar(pool, TENANT, TELEFONE, texto('1'));
  await enviar(pool, TENANT, TELEFONE, texto('01310-000'));
  await enviar(pool, TENANT, TELEFONE, texto('50'));
  const [confirmacao] = await enviar(pool, TENANT, TELEFONE, texto('não'));
  assert.ok(confirmacao.texto.includes('foto.jpg'));
  assert.equal(arquivosPedido.length, 1);
});

test('cliente já tem endereço cadastrado: pula direto pra confirmação, sem perguntar CEP', async () => {
  const clienteExistente = { id: 'cliente-existente', tenant_id: TENANT, telefone: TELEFONE, nome: 'Ana', cep: '20000-000', numero: '10' };
  const { pool, pedidos } = poolFalso({ clienteExistente });
  await enviar(pool, TENANT, TELEFONE, texto('oi'));
  await enviar(pool, TENANT, TELEFONE, botao('fazer_pedido'));
  await enviar(pool, TENANT, TELEFONE, botao('sem_arquivo'));
  await enviar(pool, TENANT, TELEFONE, texto('vaso simples'));
  const [confirmacao] = await enviar(pool, TENANT, TELEFONE, texto('1'));
  assert.ok(confirmacao.texto.includes('vaso simples'));
  assert.ok(!confirmacao.texto.includes('CEP'));
  assert.equal(pedidos.length, 1);
});

test('recebendo_arquivos: "pronto" sem nenhum arquivo enviado pede pelo menos 1', async () => {
  const { pool, conversas } = poolFalso();
  await enviar(pool, TENANT, TELEFONE, texto('oi'));
  await enviar(pool, TENANT, TELEFONE, botao('fazer_pedido'));
  await enviar(pool, TENANT, TELEFONE, botao('tem_arquivo'));
  const [envio] = await enviar(pool, TENANT, TELEFONE, texto('pronto'));
  assert.ok(envio.texto.includes('pelo menos 1 arquivo'));
  assert.equal(conversas.get(`${TENANT}|${TELEFONE}`).estado, 'recebendo_arquivos');
});

test('falha ao baixar mídia: avisa o cliente e não avança de estado', async () => {
  const { pool, conversas } = poolFalso();
  const baixarMidiaComErro = async () => { throw new Error('timeout'); };
  await enviar(pool, TENANT, TELEFONE, texto('oi'));
  await enviar(pool, TENANT, TELEFONE, botao('fazer_pedido'));
  await enviar(pool, TENANT, TELEFONE, botao('tem_arquivo'));
  const [envio] = await processarMensagem(pool, { tenantId: TENANT, telefoneE164: TELEFONE, entrada: arquivo('peca.stl'), baixarMidia: baixarMidiaComErro });
  assert.ok(envio.texto.includes('não consegui baixar'));
  assert.equal(conversas.get(`${TENANT}|${TELEFONE}`).estado, 'recebendo_arquivos');
});

test('sem etapa configurada: ainda responde ao cliente, mas não cria pedido', async () => {
  const { pool, pedidos } = poolFalso({ semEtapa: true });
  await enviar(pool, TENANT, TELEFONE, texto('oi'));
  await enviar(pool, TENANT, TELEFONE, botao('fazer_pedido'));
  await enviar(pool, TENANT, TELEFONE, botao('sem_arquivo'));
  await enviar(pool, TENANT, TELEFONE, texto('vaso simples'));
  await enviar(pool, TENANT, TELEFONE, texto('1'));
  await enviar(pool, TENANT, TELEFONE, texto('01310-000'));
  await enviar(pool, TENANT, TELEFONE, texto('50'));
  const [confirmacao] = await enviar(pool, TENANT, TELEFONE, texto('não'));
  assert.ok(confirmacao.texto.includes('Já registrei seu pedido'));
  assert.equal(pedidos.length, 0);
});
