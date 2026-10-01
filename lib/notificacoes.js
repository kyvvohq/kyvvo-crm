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
// Mesmos provedores do kyvvo-studio (Resend/Meta Cloud API — aqui via
// @kyvvohq/whatsapp, que o próprio bot do CRM já usa pra responder cliente).
// Best-effort: nunca lança, cai num modo de log sem as variáveis de
// ambiente, pra funcionar em dev/homologação sem serviço externo.
async function enviarEmailNotificacao(email, assunto, corpoTexto) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM || 'Kyvvo <no-reply@kyvvo.com.br>';
  if (!apiKey) {
    console.log(`[notificacoes] (dev) e-mail para ${email} — ${assunto}: ${corpoTexto}`);
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [email],
        subject: assunto,
        html: `<div style="font-family:Arial,Helvetica,sans-serif;padding:24px;color:#111"><p>${corpoTexto}</p></div>`,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error(`[notificacoes] Resend respondeu ${res.status} ao enviar para ${email}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[notificacoes] Falha ao enviar e-mail para ${email}: ${err.message}`);
    return false;
  }
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
      enviarEmailNotificacao(config.notificacao_email, titulo, detalhe || titulo).catch(() => {});
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
