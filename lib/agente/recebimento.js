// Parte síncrona do webhook do agente: resolve conta e canal, grava a mensagem
// (idempotente por wamid) e devolve rápido. Nada de modelo nem download aqui —
// isso é do processador (lib/agente/processador.js), que roda em seguida.
const { paraE164 } = require('../telefone');
const { extrairMudancas } = require('./entrada');

const JANELA_HORAS = 24;
const PAUSA_HUMANO_HORAS_PADRAO = 12;

// Canal + config. Só devolve quando o agente está ligado para esse número.
async function carregarCanalAtivo(pool, phoneNumberId) {
  const { rows } = await pool.query(
    `select n.phone_number_id, n.tenant_id, n.modo as canal_modo, c.modo, c.limites
       from crm_whatsapp_numeros n
       join crm_agente_config c on c.tenant_id = n.tenant_id
      where n.phone_number_id = $1 and n.status = 'ativo' and c.modo <> 'desligado'`,
    [phoneNumberId],
  );
  return rows[0] || null;
}

async function upsertConversa(pool, { tenantId, telefone, nomeWhatsapp, quando }) {
  const { rows } = await pool.query(
    `insert into crm_conversas_whatsapp
       (tenant_id, telefone_e164, estado, situacao, ultima_msg_cliente_em, janela_expira_em, nome_whatsapp, cliente_id)
     values ($1, $2, 'agente', 'bot', $3::timestamptz, $3::timestamptz + make_interval(hours => $4), $5,
             (select id from crm_clientes where tenant_id = $1 and telefone = $2))
     on conflict (tenant_id, telefone_e164) do update set
       ultima_msg_cliente_em = greatest(crm_conversas_whatsapp.ultima_msg_cliente_em, excluded.ultima_msg_cliente_em),
       janela_expira_em = greatest(crm_conversas_whatsapp.janela_expira_em, excluded.janela_expira_em),
       nome_whatsapp = coalesce(excluded.nome_whatsapp, crm_conversas_whatsapp.nome_whatsapp),
       cliente_id = coalesce(crm_conversas_whatsapp.cliente_id, excluded.cliente_id),
       situacao = case when crm_conversas_whatsapp.situacao = 'encerrada' then 'bot' else crm_conversas_whatsapp.situacao end,
       atualizado_em = now()
     returning id`,
    [tenantId, telefone, quando, JANELA_HORAS, nomeWhatsapp || null],
  );
  return rows[0].id;
}

// Devolve { nova, conversaId } — nova=false quando o wamid já tinha chegado.
async function registrarEntrada(pool, canal, msg, agora) {
  const telefone = paraE164(msg.de);
  if (!telefone || !msg.wamid) return null;
  const quando = msg.enviadaEm || agora;
  const conversaId = await upsertConversa(pool, { tenantId: canal.tenant_id, telefone, nomeWhatsapp: msg.nomeWhatsapp, quando });
  const { rows } = await pool.query(
    `insert into crm_mensagens_whatsapp (tenant_id, telefone_e164, direcao, tipo, conteudo, wamid, autor, midia, criado_em)
     values ($1, $2, 'recebida', $3, $4, $5, 'cliente', $6::jsonb, $7)
     on conflict (tenant_id, wamid) where wamid is not null do nothing
     returning id`,
    [canal.tenant_id, telefone, msg.tipo, msg.conteudo, msg.wamid, msg.midia ? JSON.stringify(msg.midia) : null, agora],
  );
  return { nova: rows.length > 0, conversaId, telefone, tenantId: canal.tenant_id };
}

// Eco do app (coexistência): uma pessoa respondeu fora do CRM. Pausa o agente.
async function registrarEco(pool, canal, eco, agora) {
  const telefone = paraE164(eco.para);
  if (!telefone || !eco.wamid) return null;
  const { rows } = await pool.query(
    `insert into crm_mensagens_whatsapp (tenant_id, telefone_e164, direcao, tipo, conteudo, wamid, autor, processada_em, criado_em)
     values ($1, $2, 'enviada', $3, $4, $5, 'humano', now(), $6)
     on conflict (tenant_id, wamid) where wamid is not null do nothing
     returning id`,
    [canal.tenant_id, telefone, eco.tipo, eco.conteudo, eco.wamid, agora],
  );
  if (rows.length === 0) return null; // já conhecido (ex.: enviado pelo próprio agente)
  const horas = Number((canal.limites || {}).pausa_humano_horas) || PAUSA_HUMANO_HORAS_PADRAO;
  await pool.query(
    `insert into crm_conversas_whatsapp (tenant_id, telefone_e164, estado, situacao, pausada_ate)
     values ($1, $2, 'agente', 'humano', $3::timestamptz + make_interval(hours => $4))
     on conflict (tenant_id, telefone_e164) do update set
       situacao = 'humano', pausada_ate = excluded.pausada_ate, atualizado_em = now()`,
    [canal.tenant_id, telefone, agora, horas],
  );
  return { telefone, tenantId: canal.tenant_id };
}

async function atualizarStatus(pool, canal, s) {
  if (!s.wamid) return;
  await pool.query(
    `update crm_mensagens_whatsapp
        set status_entrega = $3, categoria_cobranca = coalesce($4, categoria_cobranca)
      where tenant_id = $1 and wamid = $2`,
    [canal.tenant_id, s.wamid, s.status, s.categoria],
  );
}

// Retorna { tratados: Set<phoneNumberId>, novas: [{tenantId, conversaId}] }.
// Números sem agente ligado ficam fora de `tratados` e seguem para o bot antigo.
async function receberWebhook(pool, body, { agora = () => new Date() } = {}) {
  const tratados = new Set();
  const novas = [];
  for (const m of extrairMudancas(body)) {
    const canal = await carregarCanalAtivo(pool, m.phoneNumberId);
    if (!canal) continue;
    tratados.add(m.phoneNumberId);
    if (m.campo === 'smb_message_echoes') {
      for (const eco of m.ecos) await registrarEco(pool, canal, eco, agora());
      continue;
    }
    for (const s of m.statuses) await atualizarStatus(pool, canal, s);
    for (const msg of m.mensagens) {
      const r = await registrarEntrada(pool, canal, msg, agora());
      if (r && r.nova) novas.push({ tenantId: r.tenantId, conversaId: r.conversaId });
    }
  }
  return { tratados, novas };
}

module.exports = { receberWebhook, carregarCanalAtivo, registrarEntrada, registrarEco, atualizarStatus };
