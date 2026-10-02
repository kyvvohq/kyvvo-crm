// Serviço de notificações — paridade com o kyvvo-studio (server/panel/lib/
// notificacoes.js): matriz de canais (E-mail/WhatsApp/CRM) com envio real,
// tipos orientados a evento (fato pontual, registrado uma vez em
// crm_notificacoes_eventos) + tipos "de estado" (recalculados a cada
// consulta, ex.: pedidos parados), marcar como lida e histórico completo.
//
// Diferença do Studio: o CRM não tem tabela `tenants`/`usuarios` própria
// (identidade é global via kyvvo-platform), então não há um e-mail de admin
// nem um "tenants.whatsapp" prontos pra mandar notificação — o destino
// (notificacao_email/notificacao_whatsapp) é capturado uma vez em
// crm_configuracoes (tela Notificações > Regras) e reaproveitado por
// qualquer tipo com o canal ligado.
const { enviarTexto } = require('@kyvvohq/whatsapp');
const { enviarEmail } = require('./email');

const TIPOS_NOTIFICACAO = [
  {
    chave: 'pedidos_parados',
    titulo: 'Pedidos parados além do prazo da etapa',
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
  { chave: 'pedido_criado', titulo: 'Novo pedido criado', eventoUnico: true },
  { chave: 'pedido_pronto', titulo: 'Pedido pronto pra envio/retirada', eventoUnico: true },
  // Compartilhado por qualquer tipo de importação (NF-e, clientes CSV,
  // pedidos UpSeller) — o `detalhe` de cada disparo já diz qual foi e se
  // teve erro; não precisa de um tipo por formato de arquivo.
  { chave: 'importacao_concluida', titulo: 'Importação de arquivo concluída', eventoUnico: true },
  // "Quantidade restante de disparos" (pedido do Bruno) — a Meta não expõe
  // uma contagem exata de mensagens restantes, só um "tier" (limite de
  // conversas iniciadas por 24h: TIER_50/250/1K/10K/100K). Disparado pelo
  // checador periódico (lib/automacoes.js#checarLimiteDisparos), não por
  // evento — fica eventoUnico:true porque cada aviso é um fato pontual
  // ("bateu o limite nesse dia"), igual pedido_criado.
  { chave: 'whatsapp_limite_proximo', titulo: 'Limite de disparos do WhatsApp quase atingido', eventoUnico: true },
  // "Usuário aguardando atendimento" (pedido do Bruno) — o bot do CRM é 100%
  // regrado, sem conceito de handoff pra humano (diferente do Studio). Não
  // inventei um novo estado de conversa pra isso (risco alto mexer na
  // máquina de estados de um bot em produção sem poder testar ponta a
  // ponta); em vez disso, reaproveitei o ÚNICO ponto que já existia no
  // código representando "o bot não entendeu e o cliente pode estar
  // travado" — o fallback de estado desconhecido em
  // lib/bot-whatsapp.js#processarMensagem (reinicia a conversa do zero).
  { chave: 'atendimento_bot_travado', titulo: 'Cliente pode estar com dificuldade no atendimento automático', eventoUnico: true },
];

// Formato novo: {"canais": {"crm","email","whatsapp"}, ...}. Formato antigo
// ({"ativo": bool}, de antes desta tela existir) tratado como "só CRM", que
// é o que sempre existiu até aqui.
function canaisAtivos(cfg) {
  if (cfg && cfg.canais && typeof cfg.canais === 'object' && !Array.isArray(cfg.canais)) {
    return {
      crm: cfg.canais.crm !== false,
      email: !!cfg.canais.email,
      whatsapp: !!cfg.canais.whatsapp,
    };
  }
  return { crm: cfg ? cfg.ativo !== false : true, email: false, whatsapp: false };
}

// --- Envio real (E-mail/WhatsApp) -------------------------------------------
// E-mail pelo serviço da plataforma (lib/email.js — SES central no
// kyvvo-platform); WhatsApp via @kyvvohq/whatsapp, que o próprio bot do CRM
// já usa pra responder cliente. Best-effort: nunca lança, cai num modo de
// log sem as variáveis de ambiente, pra funcionar em dev/homologação.
// `chave` identifica o alerta (TIPOS_NOTIFICACAO) — o nome dele vai no
// rodapé ("a notificação X está ativada... desative em ..."). Textos
// editáveis no admin (E-mail > Modelos > CRM > Notificação).
async function enviarEmailNotificacao(email, assunto, corpoTexto, chave) {
  const tipo = TIPOS_NOTIFICACAO.find((t) => t.chave === chave);
  const detalhe = corpoTexto && corpoTexto !== assunto ? corpoTexto : '';
  return enviarEmail({
    to: email,
    subject: assunto,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;padding:24px;color:#111"><p>${escaparHtml(corpoTexto)}</p></div>`,
    text: corpoTexto,
    tag: chave ? `notificacao_${chave}` : 'notificacao',
    modelo: 'notificacao',
    variaveis: { titulo: assunto, detalhe, notificacao: tipo ? tipo.titulo : '' },
    layout: {
      tipo: 'notificacao',
      titulo: assunto,
      notificacao: tipo ? tipo.titulo : undefined,
      paragrafos: detalhe ? [detalhe] : [],
      cta: { texto: 'Abrir no CRM', url: 'https://crm.kyvvo.com.br/crm/' },
    },
  });
}

function escaparHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function enviarWhatsappNotificacao(pool, tenantId, telefone, texto) {
  if (!telefone) return false;
  try {
    // CRM é multi-número (crm_whatsapp_numeros, 1 por tenant, vinculado pelo
    // kyvvo-admin) — ao contrário do Studio, não existe "o" número default
    // pra cair no fallback de @kyvvohq/whatsapp (META_PHONE_NUMBER_ID).
    const { rows } = await pool.query('select phone_number_id from crm_whatsapp_numeros where tenant_id = $1 limit 1', [tenantId]);
    const phoneNumberId = rows[0] && rows[0].phone_number_id;
    if (!phoneNumberId) return false;
    return await enviarTexto({ to: telefone, texto, phoneNumberId });
  } catch (err) {
    console.error(`[notificacoes] Falha ao enviar WhatsApp para ${telefone}: ${err.message}`);
    return false;
  }
}

// Dispara uma notificação de EVENTO ÚNICO (pedido criado/pronto). Chamado no
// momento em que o fato acontece (index.js). Best-effort de propósito
// (try/catch amplo): nunca deve interromper a rota que disparou a
// notificação.
async function dispararNotificacaoEvento(pool, tenantId, chave, { titulo, detalhe }) {
  try {
    const { rows: cfgRows } = await pool.query(
      'select notificacoes_ativas, notificacao_email, notificacao_whatsapp from crm_configuracoes where tenant_id = $1',
      [tenantId]
    );
    const config = cfgRows[0];
    const cfg = config && (config.notificacoes_ativas || {})[chave];
    const canais = canaisAtivos(cfg);

    if (canais.crm) {
      await pool.query(
        'insert into crm_notificacoes_eventos (tenant_id, chave, titulo, detalhe) values ($1, $2, $3, $4)',
        [tenantId, chave, titulo, detalhe || null]
      );
    }
    if (canais.email && config && config.notificacao_email) {
      enviarEmailNotificacao(config.notificacao_email, titulo, detalhe || titulo, chave).catch(() => {});
    }
    if (canais.whatsapp && config && config.notificacao_whatsapp) {
      enviarWhatsappNotificacao(pool, tenantId, config.notificacao_whatsapp, detalhe ? `${titulo}\n${detalhe}` : titulo).catch(() => {});
    }
  } catch (err) {
    console.error(`[notificacoes] Falha ao disparar evento "${chave}" pro tenant ${tenantId}: ${err.message}`);
  }
}

// Chave ausente em `notificacoesAtivas` conta como ativa (default seguro) —
// só canal CRM explicitamente desmarcado desliga. Tipos sem nenhum item
// pendente/evento não lido não entram no resultado.
async function listarNotificacoesPendentes(pool, tenantId, notificacoesAtivas) {
  const todasConfigs = notificacoesAtivas || {};
  const resultado = [];
  for (const tipo of TIPOS_NOTIFICACAO) {
    const config = todasConfigs[tipo.chave] || {};
    const canais = canaisAtivos(config);
    if (!canais.crm) continue;

    if (tipo.eventoUnico) {
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await pool.query(
        `select id, titulo, detalhe, criado_em from crm_notificacoes_eventos
         where tenant_id = $1 and chave = $2 and lida = false
         order by criado_em desc limit 20`,
        [tenantId, tipo.chave]
      );
      if (rows.length) {
        resultado.push({
          tipo: tipo.chave,
          titulo: tipo.titulo,
          eventoUnico: true,
          itens: rows.map((r) => ({ id: r.id, titulo: r.titulo, detalhe: r.detalhe, desde: r.criado_em })),
        });
      }
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const itens = await tipo.calcular(pool, tenantId, config);
    if (itens.length) resultado.push({ tipo: tipo.chave, titulo: tipo.titulo, eventoUnico: false, itens });
  }
  return resultado;
}

// "Marcar como lida" — só os tipos orientados a evento têm uma linha real
// pra marcar (os "de estado" são recalculados a cada consulta).
async function marcarNotificacaoLida(pool, tenantId, id) {
  const { rows } = await pool.query(
    `update crm_notificacoes_eventos set lida = true, lida_em = now()
     where id = $1 and tenant_id = $2 and lida = false
     returning id`,
    [id, tenantId]
  );
  return rows.length > 0;
}

async function marcarTodasNotificacoesLidas(pool, tenantId) {
  const { rowCount } = await pool.query(
    `update crm_notificacoes_eventos set lida = true, lida_em = now() where tenant_id = $1 and lida = false`,
    [tenantId]
  );
  return rowCount;
}

// Histórico completo (lidas + não lidas) dos tipos orientados a evento —
// aba "Histórico". Sem filtro de canal ativo de propósito (log/auditoria do
// que já aconteceu, não lista de pendências).
async function listarHistoricoNotificacoes(pool, tenantId) {
  const { rows } = await pool.query(
    `select id, chave, titulo, detalhe, criado_em, lida, lida_em
     from crm_notificacoes_eventos
     where tenant_id = $1
     order by criado_em desc limit 200`,
    [tenantId]
  );
  const tituloPorChave = Object.fromEntries(TIPOS_NOTIFICACAO.map((t) => [t.chave, t.titulo]));
  return rows.map((r) => ({
    id: r.id,
    tipo: r.chave,
    tipoTitulo: tituloPorChave[r.chave] || r.chave,
    titulo: r.titulo,
    detalhe: r.detalhe,
    criadoEm: r.criado_em,
    lida: r.lida,
    lidaEm: r.lida_em,
  }));
}

module.exports = {
  TIPOS_NOTIFICACAO,
  canaisAtivos,
  listarNotificacoesPendentes,
  dispararNotificacaoEvento,
  marcarNotificacaoLida,
  marcarTodasNotificacoesLidas,
  listarHistoricoNotificacoes,
};
