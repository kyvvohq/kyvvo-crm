// Serviço de notificações — registro de tipos + cálculo dos pendentes de um
// tenant. Mesmo desenho do kyvvo-studio (server/panel/lib/notificacoes.js):
// o balão (GET /crm/api/notificacoes) e a tela Configurações > Notificações
// (GET/PATCH /crm/api/notificacoes/config) leem esta lista, não um tipo
// hard-coded — tipo novo não pede endpoint novo, só uma entrada aqui.
//
// Cada tipo: `chave` (persistida em crm_configuracoes.notificacoes_ativas,
// formato {"<chave>": {"ativo": bool, ...params}} — escolhido pra caber
// parâmetro extra por tipo sem precisar de coluna nova a cada notificação
// nova), `titulo` (rótulo no dropdown do balão e no toggle de
// Configurações) e `calcular(pool, tenantId, config)` -> array de itens
// pendentes (vazio = nada a notificar agora); `config` é o objeto salvo pro
// tenant nessa chave (nunca null — listarNotificacoesPendentes normaliza).
const TIPOS_NOTIFICACAO = [
  {
    chave: 'pedidos_parados',
    titulo: 'Pedidos parados além do prazo da etapa',
    // Mesma query do card "Orçamentos parados" do Painel Hoje
    // (/crm/api/painel-hoje) — o critério de "parado" já existe ali, só
    // reaproveitado aqui pro balão de notificações.
    async calcular(pool, tenantId) {
      const { rows } = await pool.query(
        `select p.id, c.nome as cliente_nome, e.nome as etapa_nome,
                extract(day from now() - p.entrou_na_etapa_em)::int as dias_parado
         from crm_pedidos p
         join crm_etapas e on e.id = p.etapa_id
         join crm_clientes c on c.id = p.cliente_id
         where p.tenant_id = $1 and e.tipo = 'aberta' and e.prazo_alerta_dias is not null
           and p.entrou_na_etapa_em < now() - (e.prazo_alerta_dias || ' days')::interval
         order by dias_parado desc`,
        [tenantId]
      );
      return rows.map((p) => ({
        id: p.id,
        titulo: p.cliente_nome || 'Sem nome',
        detalhe: `parado em "${p.etapa_nome}" há ${p.dias_parado} dia(s)`,
      }));
    },
  },
];

// Chave ausente em `notificacoesAtivas` conta como ativa (default seguro) —
// só `ativo: false` explícito desliga. Tipos sem nenhum item pendente não
// entram no resultado (o balão/dropdown não precisam saber distinguir "0
// itens" de "tipo nem existe").
async function listarNotificacoesPendentes(pool, tenantId, notificacoesAtivas) {
  const todasConfigs = notificacoesAtivas || {};
  const resultado = [];
  for (const tipo of TIPOS_NOTIFICACAO) {
    const config = todasConfigs[tipo.chave] || {};
    if (config.ativo === false) continue;
    const itens = await tipo.calcular(pool, tenantId, config);
    if (itens.length) resultado.push({ tipo: tipo.chave, titulo: tipo.titulo, itens });
  }
  return resultado;
}

module.exports = { TIPOS_NOTIFICACAO, listarNotificacoesPendentes };
