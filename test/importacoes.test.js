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

test('parseNfeXml: extrai chave, cliente, itens e valor total', () => {
  const xml = `<nfeProc><NFe><infNFe Id="NFe35240112345678901234550010000012341123456789">
    <ide><nNF>1234</nNF></ide>
    <dest><xNome>Cliente Teste</xNome><CPF>12345678900</CPF>
      <enderDest><xMun>Uberlândia</xMun><UF>MG</UF><fone>34999998888</fone></enderDest>
    </dest>
    <det nItem="1"><prod><xProd>Bolo decorado</xProd><qCom>2.0000</qCom><vUnCom>50.00</vUnCom></prod></det>
    <total><ICMSTot><vNF>100.00</vNF></ICMSTot></total>
    <infAdic><infCpl>Referente ao Pedido: ABC123</infCpl></infAdic>
  </infNFe></NFe></nfeProc>`;
  const dados = parseNfeXml(xml);
  assert.equal(dados.chave_nfe, '35240112345678901234550010000012341123456789');
  assert.equal(dados.numero_nota, '1234');
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

test('parseNfeXml: sem chave de acesso lança erro', () => {
  assert.throws(() => parseNfeXml('<nfeProc></nfeProc>'), /Chave de acesso/);
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
