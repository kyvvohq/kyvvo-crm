// Gatilhos de encaminhamento garantidos em código. O prompt pede ao modelo que chame
// transferir_para_equipe nesses casos, mas modelos pequenos às vezes só respondem em texto
// (medido nos evals). Aqui o servidor lê a mensagem da cliente e garante o handoff — o
// modelo continua conduzindo a conversa, só não pode "esquecer" de passar para a equipe.
// Padrões conservadores de propósito: falso positivo = um encaminhamento a mais; falso
// negativo = cliente com problema esperando sem ninguém ver.
const { normalizar } = require('./posfiltro');

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
  const t = normalizar(texto);
  return GATILHOS
    .filter(([motivo, re]) => re.test(t) && !(motivo === 'negociacao_desconto' && vipConfirmado))
    .map(([motivo]) => motivo);
}

function perguntaComercial(texto) {
  return COMERCIAL.test(normalizar(texto));
}

// ID de pedido da Shopee: token alfanumérico de 10 a 24 caracteres com letras E números,
// só considerado quando a mensagem fala de Shopee/ID/pedido (evita pegar CEP, telefone etc.).
function extrairIdShopee(texto) {
  if (!/shopee|\bid\b|pedido/i.test(texto)) return null;
  for (const token of String(texto).toUpperCase().match(/\b[A-Z0-9]{10,24}\b/g) || []) {
    if (/\d/.test(token) && /[A-Z]/.test(token)) return token;
  }
  return null;
}

module.exports = { detectarGatilhos, perguntaComercial, extrairIdShopee, GATILHOS };
