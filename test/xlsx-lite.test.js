const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lerPrimeiraAba } = require('../lib/xlsx-lite');

// Constrói um .xlsx mínimo (zip "stored", sem compressão) só com o que
// lib/xlsx-lite.js precisa: xl/worksheets/sheet1.xml, opcionalmente
// xl/sharedStrings.xml. Não é um zip genérico, só o bastante pra testar o
// leitor real de ponta a ponta sem depender de um arquivo binário no repo.
function crc32(buf) {
  let c;
  const tabela = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabela[n] = c;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = tabela[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function construirZip(arquivos) {
  const locais = [];
  const centrais = [];
  let offset = 0;
  for (const [nome, conteudo] of Object.entries(arquivos)) {
    const dados = Buffer.from(conteudo, 'utf8');
    const nomeBuf = Buffer.from(nome, 'utf8');
    const crc = crc32(dados);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8); // método 0 = stored
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(dados.length, 18);
    header.writeUInt32LE(dados.length, 22);
    header.writeUInt16LE(nomeBuf.length, 26);
    header.writeUInt16LE(0, 28);

    locais.push(Buffer.concat([header, nomeBuf, dados]));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(dados.length, 20);
    central.writeUInt32LE(dados.length, 24);
    central.writeUInt16LE(nomeBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrais.push(Buffer.concat([central, nomeBuf]));

    offset += locais[locais.length - 1].length;
  }

  const localBuf = Buffer.concat(locais);
  const centralBuf = Buffer.concat(centrais);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Object.keys(arquivos).length, 8);
  eocd.writeUInt16LE(Object.keys(arquivos).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localBuf, centralBuf, eocd]);
}

test('lerPrimeiraAba: lê inline strings (LibreOffice/PhpSpreadsheet)', () => {
  const sheet = `<?xml version="1.0"?><worksheet><sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>Nome</t></is></c><c r="B1" t="inlineStr"><is><t>Idade</t></is></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>Ana</t></is></c><c r="B2"><v>30</v></c></row>
  </sheetData></worksheet>`;
  const buffer = construirZip({ 'xl/worksheets/sheet1.xml': sheet });
  const linhas = lerPrimeiraAba(buffer);
  assert.deepEqual(linhas, [['Nome', 'Idade'], ['Ana', '30']]);
});

test('lerPrimeiraAba: lê shared strings (Excel/Google Sheets)', () => {
  const shared = `<?xml version="1.0"?><sst><si><t>Cidade</t></si><si><t>Uberl&#226;ndia</t></si></sst>`;
  const sheet = `<?xml version="1.0"?><worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c></row>
    <row r="2"><c r="A2" t="s"><v>1</v></c></row>
  </sheetData></worksheet>`;
  const buffer = construirZip({ 'xl/worksheets/sheet1.xml': sheet, 'xl/sharedStrings.xml': shared });
  const linhas = lerPrimeiraAba(buffer);
  assert.deepEqual(linhas, [['Cidade'], ['Uberlândia']]);
});

test('lerPrimeiraAba: sem sheet1.xml lança erro', () => {
  const buffer = construirZip({ 'xl/outraCoisa.xml': '<a/>' });
  assert.throws(() => lerPrimeiraAba(buffer), /sheet1\.xml/);
});
