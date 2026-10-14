// Única instanciação de @kyvvohq/agente-core pro CRM inteiro — todos os
// outros arquivos de lib/agente/* importam a instância bindada daqui, em
// vez de cada um chamar criarAgenteCore() de novo (evitaria validar os
// nomes de tabela N vezes à toa e criaria N objetos equivalentes).
const { criarAgenteCore } = require('@kyvvohq/agente-core');

const agenteCore = criarAgenteCore({
  tabelas: {
    config: 'crm_agente_config',
    conhecimento: 'crm_agente_conhecimento',
    conversas: 'crm_conversas_whatsapp',
    mensagens: 'crm_mensagens_whatsapp',
    execucoes: 'crm_agente_execucoes',
    handoffs: 'crm_handoffs',
    numeros: 'crm_whatsapp_numeros',
    anexos: 'crm_anexos',
    clientes: 'crm_clientes',
  },
});

module.exports = agenteCore;
