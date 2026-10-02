// Padrão de PDF de relatório da Kyvvo — não existia nenhum até aqui (o
// pedido do Bruno explicitamente autorizou criar um, caso não houvesse).
// Mesma paleta de cor da marca já usada no Design System/kyvvo-people (roxo
// de destaque #7C5CFC) — mantém consistência visual com o resto do produto
// mesmo sem poder "importar" CSS de verdade dentro de um PDF.
//
// Layout por página: cabeçalho com a marca "kyvvo CRM" CENTRALIZADA (pedido
// explícito) + título do relatório em roxo logo abaixo, conteúdo no meio, e
// rodapé fixo (copyright + data de geração) repetido em toda página nova.
const PDFDocument = require('pdfkit');

const COR = {
  texto: '#0F111A',
  textoSecundario: '#2B3040',
  muted: '#6B7385',
  accent: '#7C5CFC',
  accentStrong: '#4E33C4',
  border: '#E7EAF2',
  headerBg: '#F8F9FC',
};

const MARGEM = 40;

function desenharCabecalho(doc, tituloRelatorio) {
  const largura = doc.page.width;
  doc.rect(0, 0, largura, 64).fill(COR.headerBg);

  // "kyvvo CRM" centralizado — mesma composição do topo do app (kyvvo em
  // peso maior + CRM ao lado), só que sem o acento gráfico em gradiente que
  // o CSS usa (pdfkit não tem gradiente de texto nativo).
  // Texto bicolor desenhado em 2 chamadas independentes com x/y explícitos
  // (em vez de {continued:true}) — o modo "continued" do pdfkit entrou em
  // recursão infinita aqui (bug real descoberto testando: Maximum call
  // stack size exceeded em PDFDocument._fragment), provavelmente por
  // misturar texto encadeado com uma chamada posicionada manualmente logo
  // depois (o título, abaixo). Cada trecho desenhado isoladamente evita o
  // problema de vez.
  doc.font('Helvetica-Bold').fontSize(18);
  const larguraKyvvo = doc.widthOfString('kyvvo ');
  const larguraCrm = doc.widthOfString('CRM');
  const xInicio = (largura - larguraKyvvo - larguraCrm) / 2;
  doc.fillColor(COR.accentStrong).text('kyvvo ', xInicio, 20, { lineBreak: false });
  doc.fillColor(COR.texto).text('CRM', xInicio + larguraKyvvo, 20, { lineBreak: false });

  // lineBreak:false (não `width`+`align:center`) de propósito — descoberto
  // ao vivo: um texto que pode quebrar linha aqui dispara a paginação
  // automática do pdfkit (LineWrapper.nextSection → continueOnNewPage →
  // addPage → emite 'pageAdded' de novo → desenha o título de novo → loop
  // infinito, RangeError: Maximum call stack size exceeded). Título de
  // relatório é sempre curto o bastante pra caber numa linha só.
  doc.font('Helvetica-Bold').fontSize(15);
  const larguraTitulo = doc.widthOfString(tituloRelatorio);
  doc.fillColor(COR.accent).text(tituloRelatorio, (largura - larguraTitulo) / 2, 78, { lineBreak: false });

  doc.moveTo(MARGEM, 102).lineTo(largura - MARGEM, 102).strokeColor(COR.border).lineWidth(1).stroke();
}

// Causa raiz do loop infinito original (achada reproduzindo com só 2
// `addPage()` seguidos, sem tabela nenhuma): o rodapé desenha DENTRO da
// margem inferior da página (de propósito — é rodapé) — qualquer `.text()`
// escrito abaixo de `page.height - margins.bottom` faz o pdfkit achar que
// não coube e tentar paginar sozinho (`continueOnNewPage`), o que dispara
// 'pageAdded' nesta mesma função de novo → recursão infinita. Zera a
// margem inferior só durante o desenho do rodapé (truque padrão do pdfkit
// pra conteúdo que mora na margem) e restaura em seguida.
function desenharRodape(doc) {
  const margemInferiorOriginal = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  const y = doc.page.height - 34;
  doc.moveTo(MARGEM, y).lineTo(doc.page.width - MARGEM, y).strokeColor(COR.border).lineWidth(1).stroke();
  doc.font('Helvetica').fontSize(8).fillColor(COR.muted)
    .text(
      `© ${new Date().getFullYear()} CRM Kyvvo powered by kyvvo — gerado em ${new Date().toLocaleString('pt-BR')}`,
      MARGEM, y + 8, { width: doc.page.width - MARGEM * 2, align: 'center', lineBreak: false }
    );
  doc.page.margins.bottom = margemInferiorOriginal;
}

function novoDocumentoRelatorio(tituloRelatorio) {
  const doc = new PDFDocument({ margin: MARGEM, size: 'A4', autoFirstPage: false });
  doc.on('pageAdded', () => {
    desenharCabecalho(doc, tituloRelatorio);
    desenharRodape(doc);
    doc.y = 118;
  });
  doc.addPage();
  return doc;
}

function formatarMoedaPdf(valor) {
  return Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// Cards de resumo (quantidade/valor total/ticket médio/frete) lado a lado —
// mesma ideia dos cards de KPI já usados nas telas do app (Painel Hoje,
// Clientes), só redesenhado em PDFKit (sem CSS grid disponível aqui).
function desenharResumo(doc, cards) {
  const largura = doc.page.width - MARGEM * 2;
  const gap = 10;
  const larguraCard = (largura - gap * (cards.length - 1)) / cards.length;
  const y = doc.y;
  const altura = 54;
  cards.forEach((card, i) => {
    const x = MARGEM + i * (larguraCard + gap);
    doc.roundedRect(x, y, larguraCard, altura, 6).fillAndStroke('#FFFFFF', COR.border);
    doc.font('Helvetica').fontSize(8).fillColor(COR.muted).text(card.rotulo.toUpperCase(), x + 10, y + 10, { width: larguraCard - 20, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(14).fillColor(COR.texto).text(card.valor, x + 10, y + 26, { width: larguraCard - 20, lineBreak: false });
  });
  doc.y = y + altura + 20;
}

// Tabela genérica (cabeçalho + linhas) — usada pro "detalhado" do relatório
// de pedidos, mas serve pra qualquer relatório tabular futuro. Quebra de
// página automática via o listener 'pageAdded' já configurado em
// novoDocumentoRelatorio (redesenha cabeçalho/rodapé/título sozinho).
function desenharTabela(doc, colunas, linhas) {
  const largura = doc.page.width - MARGEM * 2;
  const larguraColuna = largura / colunas.length;
  const alturaLinha = 22;

  function cabecalhoTabela() {
    doc.rect(MARGEM, doc.y, largura, alturaLinha).fill(COR.headerBg);
    let x = MARGEM;
    colunas.forEach((col) => {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(COR.textoSecundario)
        .text(col.titulo.toUpperCase(), x + 8, doc.y + 6, { width: larguraColuna - 16, align: col.align || 'left', lineBreak: false });
      x += larguraColuna;
    });
    doc.y += alturaLinha;
  }

  cabecalhoTabela();
  linhas.forEach((linha, i) => {
    if (doc.y + alturaLinha > doc.page.height - 50) {
      doc.addPage();
      cabecalhoTabela();
    }
    if (i % 2 === 1) doc.rect(MARGEM, doc.y, largura, alturaLinha).fill('#FBFBFD');
    let x = MARGEM;
    colunas.forEach((col) => {
      doc.font('Helvetica').fontSize(9).fillColor(COR.textoSecundario)
        .text(String(linha[col.chave] ?? ''), x + 8, doc.y + 6, { width: larguraColuna - 16, align: col.align || 'left', lineBreak: false });
      x += larguraColuna;
    });
    doc.y += alturaLinha;
  });
}

module.exports = { novoDocumentoRelatorio, desenharResumo, desenharTabela, formatarMoedaPdf, COR };
