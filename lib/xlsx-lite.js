const zlib = require('zlib');

// Leitor mínimo de .xlsx (é um zip com XML dentro) sem dependência nova —
// só a primeira aba, só o que a importação do UpSeller precisa. Não é um
// parser de zip genérico: lê o End of Central Directory pra achar os
// arquivos, sem suportar zip64 (planilha de pedidos nunca chega nesse
// tamanho).
function lerEntradasZip(buffer) {
  const fimAssinatura = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.subarray(i, i + 4).equals(fimAssinatura)) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('Arquivo não parece ser um .xlsx válido (zip sem EOCD)');

  const totalEntradas = buffer.readUInt16LE(eocd + 10);
  const offsetCentral = buffer.readUInt32LE(eocd + 16);

  const entradas = {};
  let ponteiro = offsetCentral;
  for (let i = 0; i < totalEntradas; i++) {
    if (!buffer.subarray(ponteiro, ponteiro + 4).equals(Buffer.from([0x50, 0x4b, 0x01, 0x02]))) {
      throw new Error('Central directory inválida no .xlsx');
    }
    const metodo = buffer.readUInt16LE(ponteiro + 10);
    const tamanhoCompactado = buffer.readUInt32LE(ponteiro + 20);
    const tamanhoNome = buffer.readUInt16LE(ponteiro + 28);
    const tamanhoExtra = buffer.readUInt16LE(ponteiro + 30);
    const tamanhoComentario = buffer.readUInt16LE(ponteiro + 32);
    const offsetLocal = buffer.readUInt32LE(ponteiro + 42);
    const nome = buffer.toString('utf8', ponteiro + 46, ponteiro + 46 + tamanhoNome);

    entradas[nome] = { metodo, tamanhoCompactado, offsetLocal };
    ponteiro += 46 + tamanhoNome + tamanhoExtra + tamanhoComentario;
  }
  return entradas;
}

function extrairArquivo(buffer, entradas, nome) {
  const entrada = entradas[nome];
  if (!entrada) return null;
  const nomeLen = buffer.readUInt16LE(entrada.offsetLocal + 26);
  const extraLen = buffer.readUInt16LE(entrada.offsetLocal + 28);
  const inicioDados = entrada.offsetLocal + 30 + nomeLen + extraLen;
  const dados = buffer.subarray(inicioDados, inicioDados + entrada.tamanhoCompactado);
  if (entrada.metodo === 0) return dados;
  if (entrada.metodo === 8) return zlib.inflateRawSync(dados);
  throw new Error(`Método de compressão .xlsx não suportado: ${entrada.metodo}`);
}

function decodificarEntidades(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function colunaParaIndice(ref) {
  const letras = ref.match(/[A-Z]+/)[0];
  let n = 0;
  for (const ch of letras) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// Retorna a primeira aba como array de arrays (linha 0 = cabeçalho).
// Suporta os dois jeitos que planilha real usa pra guardar texto: shared
// strings (Excel/Google Sheets) e inline strings (LibreOffice/PhpSpreadsheet
// — é o que o relatório da UpSeller usa).
function lerPrimeiraAba(buffer) {
  const entradas = lerEntradasZip(buffer);
  const sheetBuf = extrairArquivo(buffer, entradas, 'xl/worksheets/sheet1.xml');
  if (!sheetBuf) throw new Error('xl/worksheets/sheet1.xml não encontrado — .xlsx sem abas ou corrompido');
  const sheetXml = sheetBuf.toString('utf8');

  let shared = [];
  const sharedBuf = extrairArquivo(buffer, entradas, 'xl/sharedStrings.xml');
  if (sharedBuf) {
    const sharedXml = sharedBuf.toString('utf8');
    shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => {
      const texto = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('');
      return decodificarEntidades(texto);
    });
  }

  const linhasXml = [...sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)];
  return linhasXml.map((linhaMatch) => {
    const celulasXml = [...linhaMatch[1].matchAll(/<c\s+r="([A-Z]+\d+)"[^>]*>([\s\S]*?)<\/c>/g)];
    const arr = [];
    for (const [tagCompleta, ref, interno] of celulasXml) {
      const idx = colunaParaIndice(ref);
      let valor = null;
      if (/t="inlineStr"/.test(tagCompleta)) {
        const t = interno.match(/<t[^>]*>([\s\S]*?)<\/t>/);
        valor = t ? decodificarEntidades(t[1]) : '';
      } else if (/t="s"/.test(tagCompleta)) {
        const v = interno.match(/<v>([\s\S]*?)<\/v>/);
        valor = v ? shared[Number(v[1])] ?? null : null;
      } else {
        const v = interno.match(/<v>([\s\S]*?)<\/v>/);
        valor = v ? decodificarEntidades(v[1]) : null;
      }
      arr[idx] = valor;
    }
    return arr;
  });
}

module.exports = { lerPrimeiraAba };
