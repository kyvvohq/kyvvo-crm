// Bloco de contexto dinâmico pro perfil da Kyvvo (atendimento geral/suporte/
// vendas) — análogo a lib/agente/contexto.js, mas em vez do rascunho de
// pedido (Basic 3D Print), mostra o Lead/Chamado aberto do cliente, se
// existir, pra IA não duplicar registro no meio de uma conversa.
const { dentroDoHorario } = require('./horario');

async function blocoDinamico(pool, { tenantId, conversa, config, agora }) {
  const linhas = ['Contexto desta conversa (informação do sistema, não escrita pelo contato):'];
  const fuso = (config.horario_atendimento || {}).fuso || 'America/Sao_Paulo';
  linhas.push(`- Data e hora atuais: ${new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: fuso }).format(agora)} (${fuso})`);

  const dentro = dentroDoHorario(config.horario_atendimento, agora);
  linhas.push(`- Atendimento humano: ${dentro ? 'DENTRO' : 'FORA'} do horário.`);
  if (!dentro && config.mensagem_fora_horario) linhas.push(`- Aviso padrão fora do horário (adapte sem prometer horário): "${config.mensagem_fora_horario}"`);

  const { rows: [env] } = await pool.query(
    "select count(*)::int as n from crm_mensagens_whatsapp where tenant_id = $1 and telefone_e164 = $2 and direcao = 'enviada'", [tenantId, conversa.telefone_e164]);
  linhas.push(`- Primeira mensagem desta conversa: ${env.n === 0 ? 'sim, apresente-se como assistente virtual da Kyvvo' : 'não, já houve resposta antes'}.`);

  let primeiroNome = null;
  if (conversa.cliente_id) {
    const { rows: [c] } = await pool.query('select nome from crm_clientes where tenant_id = $1 and id = $2', [tenantId, conversa.cliente_id]);
    if (c && c.nome && c.nome !== 'Sem nome') primeiroNome = c.nome.trim().split(/\s+/)[0];
  }
  if (!primeiroNome && conversa.nome_whatsapp) primeiroNome = conversa.nome_whatsapp.trim().split(/\s+/)[0];
  linhas.push(`- Contato: ${primeiroNome || 'nome ainda desconhecido'} (${conversa.cliente_id ? 'já cadastrado' : 'ainda sem cadastro'}).`);

  if (conversa.cliente_id) {
    const { rows: [lead] } = await pool.query(
      `select l.id, l.produto_interesse, l.empresa, e.nome as etapa
         from crm_leads l join crm_leads_etapas e on e.id = l.etapa_id
        where l.tenant_id = $1 and l.cliente_id = $2 and e.tipo = 'aberta'
        order by l.criado_em desc limit 1`,
      [tenantId, conversa.cliente_id]
    );
    linhas.push(lead
      ? `- Lead em aberto (etapa "${lead.etapa}"${lead.empresa ? `, empresa ${lead.empresa}` : ''}${lead.produto_interesse ? `, interesse em ${lead.produto_interesse}` : ''}) — não crie outro, use registrar_lead pra complementar este.`
      : '- Lead em aberto: nenhum.');

    const { rows: [chamado] } = await pool.query(
      `select id, categoria, status from crm_chamados
        where tenant_id = $1 and cliente_id = $2 and status not in ('resolvido', 'fechado')
        order by criado_em desc limit 1`,
      [tenantId, conversa.cliente_id]
    );
    linhas.push(chamado
      ? `- Chamado em aberto (categoria "${chamado.categoria || 'outro'}", status "${chamado.status}") — não abra outro pro mesmo problema.`
      : '- Chamado em aberto: nenhum.');
  }

  return linhas.join('\n');
}

module.exports = { blocoDinamico };
