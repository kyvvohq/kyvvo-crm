const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { processarMensagem, saudacaoTexto, SAUDACAO_BOTOES, textoDaEntrada, textoDoEnvio } = require('../lib/bot-whatsapp');

describe('textoDaEntrada (histórico de mensagens — o que o cliente mandou)', () => {
  test('texto: devolve o texto puro', () => {
    assert.equal(textoDaEntrada({ tipo: 'texto', texto: 'Oi, quero fazer um pedido' }), 'Oi, quero fazer um pedido');
  });
  test('botão: identifica o id clicado', () => {
    assert.equal(textoDaEntrada({ tipo: 'botao', id: 'fazer_pedido' }), '[clicou: fazer_pedido]');
  });
  test('arquivo: usa o nome do arquivo quando existe', () => {
    assert.equal(textoDaEntrada({ tipo: 'arquivo', mediaId: 'media-1', nomeArquivo: 'peca.stl' }), '[arquivo enviado: peca.stl]');
  });
  test('arquivo sem nome: cai pro mediaId', () => {
    assert.equal(textoDaEntrada({ tipo: 'arquivo', mediaId: 'media-1', nomeArquivo: null }), '[arquivo enviado: media-1]');
  });
});

describe('textoDoEnvio (histórico de mensagens — o que o bot respondeu)', () => {
  test('texto: devolve o texto puro', () => {
    assert.equal(textoDoEnvio({ tipo: 'texto', texto: 'Perfeito!' }), 'Perfeito!');
  });
  test('botões: junta o texto com os rótulos', () => {
    const r = textoDoEnvio({ tipo: 'botoes', texto: 'Escolha:', botoes: [{ id: 'a', titulo: 'Opção A' }, { id: 'b', titulo: 'Opção B' }] });
    assert.equal(r, 'Escolha:\n[Opção A | Opção B]');
  });
  test('lista: junta o texto com os rótulos das opções', () => {
    const r = textoDoEnvio({ tipo: 'lista', texto: 'Tipo da peça:', tituloBotao: 'Escolher', opcoes: [{ id: 'x', titulo: 'Brinde' }] });
    assert.equal(r, 'Tipo da peça:\n[Brinde]');
  });
});

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
      if (/^select endereco_completo from crm_clientes/.test(sql)) {
        const [, telefone] = params;
        const c = clientes.get(telefone);
        return { rows: c ? [{ endereco_completo: c.endereco_completo || null }] : [] };
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
      if (/^update crm_clientes set endereco_completo = \$1/.test(sql)) {
        const [enderecoCompleto, clienteId] = params;
        for (const c of clientes.values()) if (c.id === clienteId) c.endereco_completo = enderecoCompleto;
        return { rows: [] };
      }
      throw new Error('query inesperada: ' + sql);
    },
    connect: async () => ({
      query: async (sql, params) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
        if (/^select coalesce\(max\(numero\)/.test(sql)) {
          return { rows: [{ proximo: pedidos.length + 1 }] };
        }
        if (/^insert into crm_pedidos \(/.test(sql)) {
          const pedido = { id: `pedido-${pedidos.length + 1}`, tenant_id: params[0], cliente_id: params[1], etapa_id: params[2], numero: params[3] };
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

test('saudacaoTexto: usa o primeiro nome do WhatsApp quando disponível', () => {
  assert.ok(saudacaoTexto('Maria da Silva').startsWith('Olá, Maria! 👋'));
  assert.ok(saudacaoTexto(null).startsWith('Olá! 👋'));
});

test('primeira mensagem: manda a saudação com nome e botões', async () => {
  const { pool, conversas } = poolFalso();
  const envios = await enviar(pool, TENANT, TELEFONE, texto('oi'), { nomeWhatsapp: 'Ana Ribeiro' });
  assert.deepEqual(envios, [{ tipo: 'botoes', texto: saudacaoTexto('Ana Ribeiro'), botoes: SAUDACAO_BOTOES }]);
  assert.equal(conversas.get(`${TENANT}|${TELEFONE}`).estado, 'aguardando_opcao');
});

test('ver_lojas -> encerrar_atendimento: agradece e encerra', async () => {
  const { pool, conversas, pedidos } = poolFalso();
  await enviar(pool, TENANT, TELEFONE, texto('oi'));
  const [lojas] = await enviar(pool, TENANT, TELEFONE, botao('ver_lojas'));
  assert.equal(lojas.tipo, 'botoes');
  assert.ok(lojas.texto.includes('Shopee'));
  const [despedida] = await enviar(pool, TENANT, TELEFONE, botao('encerrar_atendimento'));
  assert.ok(despedida.texto.includes('Até mais'));
  assert.equal(conversas.has(`${TENANT}|${TELEFONE}`), false);
  assert.equal(pedidos.length, 0);
});

test('ver_lojas -> voltar_menu: volta pra saudação, não encerra', async () => {
  const { pool, conversas } = poolFalso();
  await enviar(pool, TENANT, TELEFONE, texto('oi'));
  await enviar(pool, TENANT, TELEFONE, botao('ver_lojas'));
  const [voltou] = await enviar(pool, TENANT, TELEFONE, botao('voltar_menu'));
  assert.equal(voltou.tipo, 'botoes');
  assert.equal(conversas.get(`${TENANT}|${TELEFONE}`).estado, 'aguardando_opcao');
});

test('fluxo com arquivo: vários arquivos, cor, quantidade, endereço numa mensagem só', async () => {
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

  const [pedeEndereco] = await enviar(pool, TENANT, TELEFONE, texto('3'));
  assert.ok(pedeEndereco.texto.includes('endereço completo'));

  const enderecoExemplo = 'Rua das Flores, 123, Apto 202, Centro, Uberlândia - MG, 38400-000';
  const [confirmacao] = await enviar(pool, TENANT, TELEFONE, texto(enderecoExemplo), { nomeWhatsapp: 'Maria da Silva' });

  assert.ok(confirmacao.texto.includes('peca.stl'));
  assert.ok(confirmacao.texto.includes('foto-referencia.png'));
  assert.ok(confirmacao.texto.includes('vermelho'));
  assert.ok(confirmacao.texto.includes('3'));
  assert.ok(confirmacao.texto.includes(enderecoExemplo));

  assert.equal(conversas.has(`${TENANT}|${TELEFONE}`), false);
  assert.equal(clientes.get(TELEFONE).nome, 'Maria da Silva');
  assert.equal(clientes.get(TELEFONE).endereco_completo, enderecoExemplo);
  assert.equal(pedidos.length, 1);
  assert.equal(itens[0].quantidade, 3);
  assert.equal(arquivosPedido.length, 2);
});

for (const [id, tituloEsperado] of [
  ['biscoito', 'Cortador de biscoito'],
  ['projeto_3d', 'Projeto 3D'],
  ['brinde', 'Brinde'],
  ['decoracao', 'Decoração'],
]) {
  test(`fluxo sem arquivo: lista de tipo de peça "${id}" segue pro mesmo caminho`, async () => {
    const { pool, pedidos, itens } = poolFalso();
    await enviar(pool, TENANT, TELEFONE, texto('oi'));
    await enviar(pool, TENANT, TELEFONE, botao('fazer_pedido'));
    const [lista] = await enviar(pool, TENANT, TELEFONE, botao('sem_arquivo'));
    assert.equal(lista.tipo, 'lista');

    const envios = await enviar(pool, TENANT, TELEFONE, botao(id));
    assert.equal(envios.length, 2);
    assert.ok(envios[0].texto.includes('textinho maior'));
    assert.ok(envios[1].texto.includes('Sobre a sua peça'));

    const [pedeReferencia] = await enviar(pool, TENANT, TELEFONE, texto('Detalhes: logo da minha marca, uns 10cm, sem borda'));
    assert.ok(pedeReferencia.texto.includes('foto, desenho ou referência'));

    await enviar(pool, TENANT, TELEFONE, texto('Uma foto que mandei no Pinterest'));
    await enviar(pool, TENANT, TELEFONE, texto('2'));
    const [confirmacao] = await enviar(pool, TENANT, TELEFONE, texto('Rua X, 10, Bairro Y, Cidade - UF, 00000-000'));

    assert.ok(confirmacao.texto.includes(tituloEsperado));
    assert.ok(confirmacao.texto.includes('Pinterest'));
    assert.equal(pedidos.length, 1);
    assert.equal(itens[0].quantidade, 2);
  });
}

test('fluxo sem arquivo: opção "outro" pede descrição breve antes de seguir', async () => {
  const { pool } = poolFalso();
  await enviar(pool, TENANT, TELEFONE, texto('oi'));
  await enviar(pool, TENANT, TELEFONE, botao('fazer_pedido'));
  await enviar(pool, TENANT, TELEFONE, botao('sem_arquivo'));
  const [pedeDescricao] = await enviar(pool, TENANT, TELEFONE, botao('outro'));
  assert.ok(pedeDescricao.texto.includes('descreva brevemente'));

  const envios = await enviar(pool, TENANT, TELEFONE, texto('Um porta-chaves personalizado'));
  assert.equal(envios.length, 2);

  await enviar(pool, TENANT, TELEFONE, texto('sem detalhes extras'));
  await enviar(pool, TENANT, TELEFONE, texto('foto em anexo depois'));
  await enviar(pool, TENANT, TELEFONE, texto('1'));
  const [confirmacao] = await enviar(pool, TENANT, TELEFONE, texto('Rua X, 10, Bairro Y, Cidade - UF, 00000-000'));
  assert.ok(confirmacao.texto.includes('Um porta-chaves personalizado'));
});

test('entrada inesperada na lista de tipo de peça: reenvia a lista', async () => {
  const { pool, conversas } = poolFalso();
  await enviar(pool, TENANT, TELEFONE, texto('oi'));
  await enviar(pool, TENANT, TELEFONE, botao('fazer_pedido'));
  await enviar(pool, TENANT, TELEFONE, botao('sem_arquivo'));
  const [envio] = await enviar(pool, TENANT, TELEFONE, texto('não sei'));
  assert.equal(envio.tipo, 'lista');
  assert.equal(conversas.get(`${TENANT}|${TELEFONE}`).estado, 'pergunta_tipo_peca');
});

test('cliente já tem endereço cadastrado: pula a pergunta de endereço', async () => {
  const clienteExistente = { id: 'cliente-existente', tenant_id: TENANT, telefone: TELEFONE, nome: 'Ana', endereco_completo: 'Rua Já Cadastrada, 1' };
  const { pool, pedidos } = poolFalso({ clienteExistente });
  await enviar(pool, TENANT, TELEFONE, texto('oi'));
  await enviar(pool, TENANT, TELEFONE, botao('fazer_pedido'));
  await enviar(pool, TENANT, TELEFONE, botao('sem_arquivo'));
  await enviar(pool, TENANT, TELEFONE, botao('brinde'));
  await enviar(pool, TENANT, TELEFONE, texto('detalhes'));
  await enviar(pool, TENANT, TELEFONE, texto('sem referência'));
  const [confirmacao] = await enviar(pool, TENANT, TELEFONE, texto('1'));
  assert.ok(!confirmacao.texto.includes('endereço completo'));
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
  await enviar(pool, TENANT, TELEFONE, botao('projeto_3d'));
  await enviar(pool, TENANT, TELEFONE, texto('detalhes'));
  await enviar(pool, TENANT, TELEFONE, texto('sem referência'));
  await enviar(pool, TENANT, TELEFONE, texto('1'));
  const [confirmacao] = await enviar(pool, TENANT, TELEFONE, texto('Rua X, 10, Bairro Y, Cidade - UF, 00000-000'));
  assert.ok(confirmacao.texto.includes('Já registrei seu pedido'));
  assert.equal(pedidos.length, 0);
});
