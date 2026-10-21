// Bundle do perfil "kyvvo_atendimento" — tenant da própria Kyvvo (atendimento
// geral/suporte/vendas num canal só). Junta ferramentas/contexto/gatilhos/
// posfiltro no formato que lib/agente/executor.js repassa pro
// @kyvvohq/agente-core. Alternativa ao bundle de Basic 3D Print
// (produção sob encomenda), selecionado por crm_agente_config.perfil_agente.
const { FERRAMENTAS_KYVVO, executarFerramentaKyvvo, anexarMidia, transferirParaEquipeKyvvo } = require('../ferramentas-kyvvo');
const { blocoDinamico } = require('../contexto-kyvvo');
const { PADROES } = require('../posfiltro-kyvvo');
const { GATILHOS_KYVVO, COMERCIAL_KYVVO, leadMinimoExistente } = require('../gatilhos-kyvvo');

module.exports = {
  ferramentas: { FERRAMENTAS: FERRAMENTAS_KYVVO, executarFerramenta: executarFerramentaKyvvo, anexarMidia, transferirParaEquipe: transferirParaEquipeKyvvo },
  blocoDinamico,
  contexto: { rotuloAnexo: 'recebido nesta conversa' },
  posfiltro: { padroes: PADROES },
  gatilhos: {
    padroes: GATILHOS_KYVVO,
    comercial: COMERCIAL_KYVVO,
    motivoComercial: 'interesse_comercial_avancado',
    briefingMinimoExistente: leadMinimoExistente,
  },
};
