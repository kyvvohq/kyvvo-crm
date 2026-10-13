// Pós-filtro determinístico sobre a resposta final do agente. É a garantia em
// código de que o agente não orça: valor, prazo, frete, pagamento, estoque e
// desconto nunca saem na conversa, qualquer que seja o prompt ou a injeção.
// Única exceção: a frase canônica do desconto VIP (config da conta), e só
// quando consultar_cliente_vip confirmou VIP nesta execução.

// Compara sem acento e sem caixa. Mantém o tamanho do texto (NFD só separa
// diacríticos, que removemos) — os índices continuam válidos para recortes.
function normalizar(t) {
  return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const PADROES = [
  ['valor_monetario', /r\s*\$|\breais\b|\breal\b(?=\s*\d)|\d\s*(?:conto|contos|pila|pilas)\b/],
  ['valor_numerico', /\b\d{1,3}(?:\.\d{3})*,\d{2}\b(?!\s*(?:cm|mm|m|kg|g)\b)/],
  ['prazo', /dias?\s+uteis?|\b(pronto|pronta|prontos|entrego|mando|faco|termino|finalizo|garanto|prometo|ficam|ficaria|entrega|entregue|entregamos|chega|chegara|sai|envio|enviamos|produzimos|fica|ficara|consigo|conseguimos|da pra|sim)\b[^.?!\n]{0,25}\bamanha\b|\bamanha\b[^.?!\n]{0,15}\b(fica|esta|estara|chega)\b|\bate\s+(?:o\s+)?dia\b|\bate\s+(?:segunda|terca|quarta|quinta|sexta|sabado|domingo)\b|\bprazo\s+de\b|\bem\s+\d+\s*(?:dias?|semanas?|horas?)\b|\bpronto\s+(?:em|ate|para)\b/],
  ['frete', /\bfrete\b/],
  ['pagamento', /pagamento\s+(?:confirmado|recebido|aprovado)|\bpago\b|\bpix\b|\bboleto\b|\bparcel|cartao\s+de\s+credito|\bentrada\b|\bsinal\b|\bcomprovante\b/],
  ['estoque_disponibilidade', /\bem\s+estoque\b|\bestoque\b|\bdisponivel\b|\bdisponiveis\b|\bdisponibilidade\b|\bpronta?\s+entrega\b|\bnao\s+localizei\b/],
  ['desconto', /\bdesconto\b|\bpromocao\b|\bcupom\b|\b\d+\s*%|\bpor\s+cento\b/],
];

// { ok, motivos[] }. `fraseVip` só é aceita se `vipConfirmado` for true.
function filtrarResposta(texto, { fraseVip = null, vipConfirmado = false } = {}) {
  let alvo = normalizar(texto);
  if (fraseVip && vipConfirmado) {
    // remove a frase canônica antes de varrer; qualquer outra menção continua barrada
    alvo = alvo.split(normalizar(fraseVip)).join(' ');
  }
  const motivos = [];
  for (const [nome, re] of PADROES) if (re.test(alvo)) motivos.push(nome);
  return { ok: motivos.length === 0, motivos };
}

// CPF e e-mail não vão ao modelo (LGPD): mascara o que a cliente digitou.
function higienizarEntrada(texto) {
  return String(texto || '')
    .replace(/\b\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2}\b/g, '[CPF removido]')
    .replace(/\b\d{2}[.\s]?\d{3}[.\s]?\d{3}\/?\d{4}[-\s]?\d{2}\b/g, '[CNPJ removido]');
}

module.exports = { filtrarResposta, higienizarEntrada, normalizar };
