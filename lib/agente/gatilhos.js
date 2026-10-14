// Wrapper fininho de @kyvvohq/agente-core (fase 1 de padronizar o
// Atendimento entre produtos Kyvvo, 2026-10-14). A lógica de varredura é
// genérica e vive no pacote; os padrões de gatilho e a regex de "pergunta
// comercial" são decisão de negócio do CRM e ficam aqui.
const { detectarGatilhos: detectarGatilhosCore, perguntaComercial: perguntaComercialCore } = require('@kyvvohq/agente-core');

// Ordem = prioridade do motivo registrado.
const GATILHOS = [
  ['pedido_humano', /\b(falar|conversar|atendimento)\s+(com\s+)?(uma?\s+)?(atendente|pessoa|humano|humana|alguem|gente de verdade|funcionari[oa]|vendedor[a]?)\b|\batendente\b|\bpessoa de verdade\b|\bnao quero (falar com )?(robo|bot|maquina)\b|\bhumano\b/],
  ['produto_danificado_ou_diferente', /\b(quebrad[oa]s?|quebrou|danificad[oa]s?|estragad[oa]s?|rachad[oa]s?|com defeito|defeito|veio errad[oa]|chegou (errad[oa]|diferente|quebrad[oa])|diferente do (que|pedido|combinado)|nao (e|eh) o que (eu )?pedi)\b/],
  ['reclamacao', /\breclam|\bnao gostei\b|\bpessim[oa]\b|\binsatisf|\bdecepcion|\bprocon\b|\bestorn|\breembols|\bdevolu[cs]|\babsurdo\b|\binaceitavel\b/],
  ['pedido_atrasado', /\batrasad[oa]|\bainda nao chegou\b|\bja passou do prazo\b|\bdemor(ou|ando|a muito)\b/],
  ['andamento_pedido', /\bandamento\b|\bcade (o )?meu pedido\b|\bstatus do (meu )?pedido\b|\bonde (esta|ta) (o )?meu pedido\b|\bja (esta|ta) pronto\b|\bem que (pe|etapa) (esta|ta)\b/],
  ['urgencia', /\burgen|\bamanha\b|\bhoje (ainda|mesmo)\b|\bpara hoje\b|\bpra hoje\b|\bcom pressa\b|\bo mais rapido\b/],
  ['negociacao_desconto', /\bdescont|\bpromoc|\bmais barat|\bnegoci|\babatimento\b|\bfazer por menos\b|\bcupom\b|\bpreco (melhor|especial)\b/],
];

// Perguntas de valor, prazo, frete, pagamento ou disponibilidade: só encaminham depois que o briefing mínimo existe.
const COMERCIAL = /\bquanto\s+(custa|fica|sai|e|vai ficar|seria|ficaria)\b|\bqual\s+(o\s+)?(valor|preco|total)\b|\bvalor\s+(total|final)\b|\bprazo\b|\bfrete\b|\bpix\b|\bentrada\b|\bpagamento\b|\bquando (fica|chega|entrega)\b|\bem estoque\b|\bdisponivel\b/;

function detectarGatilhos(texto, { vipConfirmado = false } = {}) {
  return detectarGatilhosCore(texto, { padroes: GATILHOS, vipConfirmado, suprimirSeVip: ['negociacao_desconto'] });
}

function perguntaComercial(texto) {
  return perguntaComercialCore(texto, { comercial: COMERCIAL });
}

// ID de pedido da Shopee: token alfanumérico de 10 a 24 caracteres com letras E números,
// só considerado quando a mensagem fala de Shopee/ID/pedido (evita pegar CEP, telefone etc.).
// 100% Shopee/CRM-specific — não entra no pacote.
function extrairIdShopee(texto) {
  if (!/shopee|\bid\b|pedido/i.test(texto)) return null;
  for (const token of String(texto).toUpperCase().match(/\b[A-Z0-9]{10,24}\b/g) || []) {
    if (/\d/.test(token) && /[A-Z]/.test(token)) return token;
  }
  return null;
}

module.exports = { detectarGatilhos, perguntaComercial, extrairIdShopee, GATILHOS, COMERCIAL };
