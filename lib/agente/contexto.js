// Monta o que o modelo enxerga: histórico recente + bloco de contexto
// dinâmico + camadas fixas do prompt. `carregarConhecimento`/
// `carregarHistorico`/`montarSystem` são genéricos e vêm de
// @kyvvohq/agente-core (fase 1 de padronizar o Atendimento entre produtos
// Kyvvo, 2026-10-14), bindados com as tabelas do CRM via lib/agente/nucleo.js.
// `blocoDinamico` é 100% específico do CRM (pedido rascunho, categorias com
// quantidade padrão) — fica aqui, sem mudança de comportamento.
const agenteCore = require('./nucleo');
const { dentroDoHorario } = require('./horario');

const HISTORICO_MAX = 30;

const { carregarConhecimento, montarSystem } = agenteCore;

// Mantém a assinatura de chamada idêntica à de hoje
// (carregarHistorico(pool, tenantId, telefone)) e o rótulo de anexo
// ("recebido e anexado ao pedido") que o CRM sempre usou.
function carregarHistorico(pool, tenantId, telefone) {
  return agenteCore.carregarHistorico(pool, tenantId, telefone, {
    historicoMax: HISTORICO_MAX,
    rotuloAnexo: 'recebido e anexado ao pedido',
  });
}

async function blocoDinamico(pool, { tenantId, conversa, config, agora }) {
  const linhas = ['Contexto desta conversa (informação do sistema, não escrita pela cliente):'];
  const fuso = (config.horario_atendimento || {}).fuso || 'America/Sao_Paulo';
  linhas.push(`- Data e hora atuais: ${new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: fuso }).format(agora)} (${fuso})`);

  const dentro = dentroDoHorario(config.horario_atendimento, agora);
  const h = config.horario_atendimento || {};
  linhas.push(`- Atendimento da equipe: ${dentro ? 'DENTRO' : 'FORA'} do horário (${h.inicio || '08:00'} às ${h.fim || '18:00'}).`);
  if (!dentro && config.mensagem_fora_horario) linhas.push(`- Aviso padrão fora do horário (adapte sem prometer horário): "${config.mensagem_fora_horario}"`);

  const { rows: [env] } = await pool.query(
    "select count(*)::int as n from crm_mensagens_whatsapp where tenant_id = $1 and telefone_e164 = $2 and direcao = 'enviada'", [tenantId, conversa.telefone_e164]);
  linhas.push(`- Primeira mensagem desta conversa: ${env.n === 0 ? 'sim, apresente-se como assistente virtual' : 'não, já houve resposta antes'}.`);

  let primeiroNome = null;
  if (conversa.cliente_id) {
    const { rows: [c] } = await pool.query('select nome from crm_clientes where tenant_id = $1 and id = $2', [tenantId, conversa.cliente_id]);
    if (c && c.nome && c.nome !== 'Sem nome') primeiroNome = c.nome.trim().split(/\s+/)[0];
  }
  if (!primeiroNome && conversa.nome_whatsapp) primeiroNome = conversa.nome_whatsapp.trim().split(/\s+/)[0];
  linhas.push(`- Cliente: ${primeiroNome || 'nome ainda desconhecido'} (${conversa.cliente_id ? 'já cadastrada' : 'ainda sem cadastro'}).`);

  if (conversa.cliente_id) {
    const { rows: [p] } = await pool.query(
      'select id, numero from crm_pedidos where tenant_id = $1 and cliente_id = $2 and rascunho order by criado_em desc limit 1', [tenantId, conversa.cliente_id]);
    if (p) {
      const { rows: vals } = await pool.query(
        `select c.chave, v.valor from crm_pedidos_valores v join crm_campos_customizados c on c.id = v.campo_id
          where v.pedido_id = $1 and c.tenant_id = $2 order by c.ordem`, [p.id, tenantId]);
      const { rows: [it] } = await pool.query('select quantidade from crm_pedidos_itens where pedido_id = $1 limit 1', [p.id]);
      const dados = vals.map((v) => `${v.chave}=${v.valor}`).concat(it ? [`quantidade=${Number(it.quantidade)}`] : []);
      linhas.push(`- Pedido rascunho em aberto (nº ${p.numero}); já coletado: ${dados.length ? dados.join('; ') : 'nada ainda'}.`);
    } else linhas.push('- Pedido rascunho em aberto: nenhum.');
  }

  const cats = ((config.regras_categoria || {}).categorias || []).filter((c) => c.quantidade_padrao);
  if (cats.length) linhas.push(`- Categorias com quantidade padrão (assuma e confirme): ${cats.map((c) => `${c.nome}=${c.quantidade_padrao}`).join(', ')}.`);
  return linhas.join('\n');
}

module.exports = { carregarConhecimento, carregarHistorico, blocoDinamico, montarSystem, HISTORICO_MAX };
