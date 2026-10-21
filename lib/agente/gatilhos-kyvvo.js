// Gatilhos de handoff pro perfil da Kyvvo — análogo a lib/agente/gatilhos.js,
// adaptado de "pedido de impressão 3D" pra "suporte/vendas de produto SaaS".
const { detectarGatilhos: detectarGatilhosCore, perguntaComercial: perguntaComercialCore } = require('@kyvvohq/agente-core');

// Ordem = prioridade do motivo registrado.
const GATILHOS_KYVVO = [
  ['quer_falar_com_humano', /\b(falar|conversar|atendimento)\s+(com\s+)?(uma?\s+)?(atendente|pessoa|humano|humana|alguem|gente de verdade|funcionari[oa]|vendedor[a]?)\b|\batendente\b|\bpessoa de verdade\b|\bnao quero (falar com )?(robo|bot|maquina)\b|\bhumano\b/],
  ['duvida_tecnica_complexa', /\b(bug|erro|falha)\b|\bnao (esta |ta )?funciona(ndo)?\b|\bnao consigo\b|\bparou de funcionar\b|\bcaiu\b|\bfora do ar\b|\btravou\b|\btravando\b/],
  ['reclamacao', /\breclam|\bnao gostei\b|\bpessim[oa]\b|\binsatisf|\bdecepcion|\bprocon\b|\babsurdo\b|\binaceitavel\b/],
  ['pedido_cancelamento', /\bcancelar\b|\bcancelamento\b|\bquero sair\b|\bencerrar (a )?(minha )?conta\b|\bencerrar (a )?assinatura\b/],
  ['interesse_comercial_avancado', /\bfechar\b|\bassinar\b|\bcontratar\b|\bquero comprar\b|\bproposta\b|\bcontrato\b/],
];

// Perguntas de valor/preço/plano: só encaminham depois que o lead mínimo existe.
const COMERCIAL_KYVVO = /\bquanto\s+(custa|fica|sai|e|vai ficar|seria|ficaria)\b|\bqual\s+(o\s+)?(valor|preco)\b|\bpreco\s+(do|da)\s+plano\b|\bplanos?\s+(e\s+)?(valor|preco)\b|\bquanto\s+custa\s+o\s+(studio|crm|people|platform)\b/;

function detectarGatilhos(texto) {
  return detectarGatilhosCore(texto, { padroes: GATILHOS_KYVVO });
}

function perguntaComercial(texto) {
  return perguntaComercialCore(texto, { comercial: COMERCIAL_KYVVO });
}

// Equivalente a briefingMinimoExistente (Basic3D): só encaminha a pergunta de
// preço/plano pra equipe depois que já existe um lead com pelo menos o
// produto de interesse identificado — evita encaminhamento vazio antes da
// IA ter coletado qualquer contexto comercial.
async function leadMinimoExistente(pool, { tenantId, clienteId }) {
  if (!clienteId) return false;
  const { rows } = await pool.query(
    `select 1 from crm_leads where tenant_id = $1 and cliente_id = $2 and produto_interesse is not null limit 1`,
    [tenantId, clienteId]
  );
  return rows.length > 0;
}

module.exports = { detectarGatilhos, perguntaComercial, leadMinimoExistente, GATILHOS_KYVVO, COMERCIAL_KYVVO };
