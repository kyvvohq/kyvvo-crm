const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, parseNfeXml, importarNfe } = require('../lib/importacoes');

// Pool falso: decide a resposta pelo texto da query, o bastante pra exercitar
// os três caminhos de importarNfe sem precisar de Postgres de verdade.
function poolFalsoComPedido(pedidoExistente) {
  const chamadas = [];
  const client = {
    query: async (sql, params) => {
      chamadas.push({ sql, params });
      if (/chave_nfe = \$2/.test(sql) && /select id from crm_pedidos/.test(sql)) return { rows: [] };
      if (/identificador_externo = \$2 and chave_nfe is null/.test(sql)) return { rows: pedidoExistente ? [pedidoExistente] : [] };
      if (/update crm_pedidos set chave_nfe/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
    release: () => {},
  };
  return { pool: { connect: async () => client }, chamadas };
}

test('parseCsv: delimitador vírgula, com aspas e campo com vírgula dentro', () => {
  const texto = 'nome,cidade\n"Ana, Confeitaria",Uberlândia\nJoão,"Belo Horizonte"';
  const linhas = parseCsv(texto);
  assert.deepEqual(linhas, [
    ['nome', 'cidade'],
    ['Ana, Confeitaria', 'Uberlândia'],
    ['João', 'Belo Horizonte'],
  ]);
});

test('parseCsv: detecta delimitador ponto-e-vírgula (Excel BR)', () => {
  const texto = 'nome;telefone\nMaria;34999998888';
  const linhas = parseCsv(texto);
  assert.deepEqual(linhas, [['nome', 'telefone'], ['Maria', '34999998888']]);
});

test('parseCsv: remove BOM do início do arquivo', () => {
  const texto = '﻿nome,cidade\nAna,Uberlândia';
  const linhas = parseCsv(texto);
  assert.equal(linhas[0][0], 'nome');
});

test('parseNfeXml: extrai chave, cliente, itens, valor total e número do pedido (via xPed)', () => {
  const xml = `<nfeProc><NFe><infNFe Id="NFe35240112345678901234550010000012341123456789">
    <ide><nNF>1234</nNF><tpNF>1</tpNF></ide>
    <dest><xNome>Cliente Teste</xNome><CPF>12345678900</CPF>
      <enderDest><xMun>Uberlândia</xMun><UF>MG</UF><fone>34999998888</fone></enderDest>
    </dest>
    <det nItem="1"><prod><xProd>Bolo decorado</xProd><qCom>2.0000</qCom><vUnCom>50.00</vUnCom><xPed>ABC123</xPed></prod></det>
    <total><ICMSTot><vNF>100.00</vNF></ICMSTot></total>
  </infNFe></NFe></nfeProc>`;
  const dados = parseNfeXml(xml);
  assert.equal(dados.chave_nfe, '35240112345678901234550010000012341123456789');
  assert.equal(dados.numero_nota, '1234');
  assert.equal(dados.eh_devolucao, false);
  assert.equal(dados.cliente.nome, 'Cliente Teste');
  assert.equal(dados.cliente.cpf, '12345678900');
  assert.equal(dados.cliente.cidade, 'Uberlândia');
  assert.equal(dados.cliente.telefone, '34999998888');
  assert.equal(dados.valor_total, 100);
  assert.equal(dados.identificador_externo_ref, 'ABC123');
  assert.equal(dados.itens.length, 1);
  assert.equal(dados.itens[0].descricao, 'Bolo decorado');
  assert.equal(dados.itens[0].quantidade, 2);
  assert.equal(dados.itens[0].valor_unitario, 50);
});

test('parseNfeXml: tpNF=0 marca devolução de mercadoria', () => {
  const xml = `<nfeProc><NFe><infNFe Id="NFe35240112345678901234550010000012341123456789">
    <ide><nNF>1234</nNF><tpNF>0</tpNF></ide>
    <dest><xNome>Cliente Teste</xNome></dest>
    <det nItem="1"><prod><xProd>Item</xProd><qCom>1</qCom><vUnCom>10.00</vUnCom><xPed>XYZ</xPed></prod></det>
  </infNFe></NFe></nfeProc>`;
  assert.equal(parseNfeXml(xml).eh_devolucao, true);
});

test('parseNfeXml: sem chave de acesso lança erro', () => {
  assert.throws(() => parseNfeXml('<nfeProc></nfeProc>'), /Chave de acesso/);
});

test('importarNfe: devolução de mercadoria é ignorada sem tocar no banco', async () => {
  const chamado = { valor: false };
  const pool = { connect: async () => { chamado.valor = true; } };
  const resultado = await importarNfe(pool, 'tenant-1', { eh_devolucao: true }, 'nota.xml');
  assert.deepEqual(resultado, { status: 'devolucao_ignorada' });
  assert.equal(chamado.valor, false, 'não deveria conectar no banco pra uma devolução');
});

test('importarNfe: concilia com pedido existente pelo número do pedido, não cria cliente novo', async () => {
  const { pool, chamadas } = poolFalsoComPedido({ id: 'pedido-existente-1' });
  const nfeData = {
    chave_nfe: '11111111111111111111111111111111111111111111',
    numero_nota: '1',
    cliente: { nome: 'X', cpf: null, cnpj: null, telefone: null, cidade: null, uf: null },
    valor_total: 100,
    identificador_externo_ref: 'PED-777',
    itens: [],
  };
  const resultado = await importarNfe(pool, 'tenant-1', nfeData, 'nota.xml');
  assert.deepEqual(resultado, { status: 'conciliado', pedido_id: 'pedido-existente-1' });
  assert.ok(chamadas.some((c) => /update crm_pedidos set chave_nfe/.test(c.sql) && c.params[1] === 'pedido-existente-1'));
  assert.ok(!chamadas.some((c) => /insert into crm_pedidos /.test(c.sql)), 'não deveria criar pedido novo quando concilia');
});

test('parseNfeXml: data do pedido = <dhEmi> da nota (com fuso), não a da importação', () => {
  const xml = `<nfeProc><NFe><infNFe Id="NFe35240112345678901234550010000012341123456789">
    <ide><nNF>1</nNF><dhEmi>2026-09-24T22:19:37-03:00</dhEmi><tpNF>1</tpNF></ide>
    <dest><xNome>X</xNome></dest>
  </infNFe></NFe></nfeProc>`;
  // 22:19 em -03:00 = 01:19 do dia 25 em UTC — o instante exato é preservado.
  assert.equal(parseNfeXml(xml).data_emissao.toISOString(), '2026-09-25T01:19:37.000Z');
});

test('parseNfeXml: layout antigo <dEmi> (só data) e nota sem data', () => {
  const comDEmi = `<infNFe Id="NFe35240112345678901234550010000012341123456789"><ide><dEmi>2014-03-10</dEmi></ide></infNFe>`;
  assert.equal(parseNfeXml(comDEmi).data_emissao.toISOString(), '2014-03-10T15:00:00.000Z');
  const semData = `<infNFe Id="NFe35240112345678901234550010000012341123456789"><ide></ide></infNFe>`;
  assert.equal(parseNfeXml(semData).data_emissao, null);
});

test('parseNfeXml: extrai a série da nota (<serie>)', () => {
  const comSerie = `<infNFe Id="NFe35240112345678901234550010000012341123456789"><ide><serie>0003</serie></ide></infNFe>`;
  assert.equal(parseNfeXml(comSerie).serie, '0003');
  const semSerie = `<infNFe Id="NFe35240112345678901234550010000012341123456789"><ide></ide></infNFe>`;
  assert.equal(parseNfeXml(semSerie).serie, null);
});

test('importarNfe: pedido novo nasce com criado_em/entrou_na_etapa_em = emissão', async () => {
  const chamadas = [];
  const client = {
    query: async (sql, params) => {
      chamadas.push({ sql, params });
      if (/from crm_etapas/.test(sql)) return { rows: [{ id: 'etapa-ganha' }] };
      if (/insert into crm_clientes/.test(sql)) return { rows: [{ id: 'cliente-1' }] };
      if (/insert into crm_pedidos /.test(sql)) return { rows: [{ id: 'pedido-novo' }] };
      if (/numero/.test(sql) && /select/.test(sql)) return { rows: [{ numero: 1, proximo: 1 }] };
      return { rows: [] };
    },
    release: () => {},
  };
  const emissao = new Date('2026-09-24T22:19:37-03:00');
  const r = await importarNfe({ connect: async () => client }, 'tenant-1', {
    chave_nfe: '2'.repeat(44), numero_nota: '9', data_emissao: emissao,
    cliente: { nome: 'Y', cpf: null, cnpj: null, telefone: null, cidade: null, uf: null },
    valor_total: 10, identificador_externo_ref: null, itens: [],
  }, 'nota.xml');
  assert.equal(r.status, 'criado');
  const insert = chamadas.find((c) => /insert into crm_pedidos /.test(c.sql));
  assert.match(insert.sql, /criado_em, entrou_na_etapa_em/);
  assert.equal(insert.params[8], emissao);
});

// Bug real (2026-10-03): NF-e importada ficava com valor_recebido=0 e
// status_pagamento='pendente' (default da coluna) — "total gasto"/"ticket
// médio" do cliente (soma valor_recebido) e o card "Pagamentos pendentes"
// do Painel Hoje ficavam errados pra toda venda importada, mesmo já sendo
// uma venda concluída e faturada no passado.
test('importarNfe: pedido novo nasce com valor_recebido = valor_total e status_pagamento = pago', async () => {
  const chamadas = [];
  const client = {
    query: async (sql, params) => {
      chamadas.push({ sql, params });
      if (/from crm_etapas/.test(sql)) return { rows: [{ id: 'etapa-ganha' }] };
      if (/insert into crm_clientes/.test(sql)) return { rows: [{ id: 'cliente-1' }] };
      if (/insert into crm_pedidos /.test(sql)) return { rows: [{ id: 'pedido-novo' }] };
      if (/numero/.test(sql) && /select/.test(sql)) return { rows: [{ numero: 1, proximo: 1 }] };
      return { rows: [] };
    },
    release: () => {},
  };
  await importarNfe({ connect: async () => client }, 'tenant-1', {
    chave_nfe: '4'.repeat(44), numero_nota: '9', data_emissao: new Date(),
    cliente: { nome: 'Y', cpf: null, cnpj: null, telefone: null, cidade: null, uf: null },
    valor_total: 250, identificador_externo_ref: null, itens: [],
  }, 'nota.xml');
  const insert = chamadas.find((c) => /insert into crm_pedidos /.test(c.sql));
  assert.match(insert.sql, /valor_total, valor_recebido, status_pagamento/);
  assert.match(insert.sql, /\$5, \$5, 'pago'/);
  assert.equal(insert.params[4], 250);
});

test('importarNfe: reimportar nota já importada corrige a data do pedido', async () => {
  const chamadas = [];
  const client = {
    query: async (sql, params) => {
      chamadas.push({ sql, params });
      if (/select id from crm_pedidos where tenant_id = \$1 and chave_nfe = \$2/.test(sql)) return { rows: [{ id: 'pedido-antigo' }] };
      return { rows: [] };
    },
    release: () => {},
  };
  const emissao = new Date('2026-09-24T22:19:37-03:00');
  const r = await importarNfe({ connect: async () => client }, 'tenant-1', { chave_nfe: '3'.repeat(44), data_emissao: emissao }, 'nota.xml');
  assert.deepEqual(r, { status: 'ja_importado', pedido_id: 'pedido-antigo' });
  const upd = chamadas.find((c) => /update crm_pedidos set criado_em/.test(c.sql));
  assert.ok(upd, 'deveria corrigir criado_em');
  assert.deepEqual(upd.params, [emissao, 'pedido-antigo']);
  // Sem <serie> na nota, cai no fallback 'nfe' de sempre — reimportar não
  // muda a origem de um pedido que já tinha sido importado assim.
  const updOrigem = chamadas.find((c) => /update crm_pedidos set origem/.test(c.sql));
  assert.ok(updOrigem, 'deveria tentar corrigir a origem também');
  assert.deepEqual(updOrigem.params, ['nfe', 'pedido-antigo']);
  assert.ok(chamadas.some((c) => c.sql === 'COMMIT'));
});

test('importarNfe: série da nota mapeada em Cadastro > Origens define a origem do pedido', async () => {
  const chamadas = [];
  const client = {
    query: async (sql, params) => {
      chamadas.push({ sql, params });
      if (/select valor from crm_opcoes_cadastro/.test(sql)) return { rows: [{ valor: 'Shopee' }] };
      if (/from crm_etapas/.test(sql)) return { rows: [{ id: 'etapa-ganha' }] };
      if (/insert into crm_clientes/.test(sql)) return { rows: [{ id: 'cliente-1' }] };
      if (/insert into crm_pedidos /.test(sql)) return { rows: [{ id: 'pedido-novo' }] };
      if (/numero/.test(sql) && /select/.test(sql)) return { rows: [{ numero: 1, proximo: 1 }] };
      return { rows: [] };
    },
    release: () => {},
  };
  await importarNfe({ connect: async () => client }, 'tenant-1', {
    chave_nfe: '5'.repeat(44), numero_nota: '9', serie: '0003', data_emissao: new Date(),
    cliente: { nome: 'Y', cpf: null, cnpj: null, telefone: null, cidade: null, uf: null },
    valor_total: 50, identificador_externo_ref: null, itens: [],
  }, 'nota.xml');
  const lookup = chamadas.find((c) => /select valor from crm_opcoes_cadastro/.test(c.sql));
  assert.deepEqual(lookup.params, ['tenant-1', '0003']);
  const insert = chamadas.find((c) => /insert into crm_pedidos /.test(c.sql));
  assert.equal(insert.params[3], 'Shopee');
});

test('importarNfe: série sem mapeamento cadastrado cai no fallback "nfe"', async () => {
  const chamadas = [];
  const client = {
    query: async (sql, params) => {
      chamadas.push({ sql, params });
      if (/select valor from crm_opcoes_cadastro/.test(sql)) return { rows: [] };
      if (/from crm_etapas/.test(sql)) return { rows: [{ id: 'etapa-ganha' }] };
      if (/insert into crm_clientes/.test(sql)) return { rows: [{ id: 'cliente-1' }] };
      if (/insert into crm_pedidos /.test(sql)) return { rows: [{ id: 'pedido-novo' }] };
      if (/numero/.test(sql) && /select/.test(sql)) return { rows: [{ numero: 1, proximo: 1 }] };
      return { rows: [] };
    },
    release: () => {},
  };
  await importarNfe({ connect: async () => client }, 'tenant-1', {
    chave_nfe: '6'.repeat(44), numero_nota: '9', serie: '9999', data_emissao: new Date(),
    cliente: { nome: 'Y', cpf: null, cnpj: null, telefone: null, cidade: null, uf: null },
    valor_total: 50, identificador_externo_ref: null, itens: [],
  }, 'nota.xml');
  const insert = chamadas.find((c) => /insert into crm_pedidos /.test(c.sql));
  assert.equal(insert.params[3], 'nfe');
});
