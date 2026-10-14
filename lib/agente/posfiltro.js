// Wrapper fininho de @kyvvohq/agente-core (fase 1 de padronizar o
// Atendimento entre produtos Kyvvo, 2026-10-14). A lógica de filtro é
// genérica e vive no pacote; a lista de termos bloqueados é decisão de
// negócio do CRM e fica aqui — nunca prometer valor, prazo, frete,
// pagamento, estoque ou desconto, exceto a frase canônica de desconto VIP
// (config da conta), e só quando consultar_cliente_vip confirmou VIP nesta
// execução.
const { filtrarResposta: filtrarRespostaCore, higienizarEntrada, normalizar } = require('@kyvvohq/agente-core');

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
function filtrarResposta(texto, opts = {}) {
  return filtrarRespostaCore(texto, { padroes: PADROES, ...opts });
}

module.exports = { filtrarResposta, higienizarEntrada, normalizar, PADROES };
