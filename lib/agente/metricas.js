// Observabilidade do agente por conta: custo (tokens da IA + mensagens da Meta), taxa de bloqueio do
// filtro, qualidade das sugestões, tempo até o primeiro atendimento humano, fila de encaminhamentos
// abertos e alertas de teto. Só mede o que tem custo marginal real de terceiros (tokens e mensagens).
const { custoUsd } = require('./precos');

const LIMITE_ALERTA_TETO = 0.8;

async function calcular(pool, tenantId, { dias = 7 } = {}) {
  const d = Math.min(Math.max(Number(dias) || 7, 1), 90);
  const { rows: [cfg] } = await pool.query('select modelo_runtime, limites, horario_atendimento from crm_agente_config where tenant_id = $1', [tenantId]);
  const limites = (cfg && cfg.limites) || {};
  const fuso = (cfg && cfg.horario_atendimento && cfg.horario_atendimento.fuso) || 'America/Sao_Paulo';
  const periodo = `criado_em >= now() - make_interval(days => $2)`;

  // Execuções: volume, bloqueios, decisões da equipe, tokens por modelo
  const { rows: [ex] } = await pool.query(
    `select count(*)::int as total,
            count(*) filter (where bloqueada_por_filtro)::int as bloqueadas,
            count(*) filter (where modelo is not null)::int as chamadas_ao_modelo,
            count(*) filter (where decisao = 'aprovada')::int as aprovadas,
            count(*) filter (where decisao = 'editada')::int as editadas,
            count(*) filter (where decisao = 'descartada')::int as descartadas,
            count(distinct conversa_id)::int as conversas
       from crm_agente_execucoes where tenant_id = $1 and ${periodo}`, [tenantId, d]);
  const { rows: porModelo } = await pool.query(
    `select modelo, coalesce(sum(tokens_in), 0)::bigint as tin, coalesce(sum(tokens_out), 0)::bigint as tout
       from crm_agente_execucoes where tenant_id = $1 and modelo is not null and ${periodo} group by modelo`, [tenantId, d]);
  let custoIa = 0; let custoIaCompleto = true;
  const tokens = { entrada: 0, saida: 0 };
  for (const m of porModelo) {
    tokens.entrada += Number(m.tin); tokens.saida += Number(m.tout);
    const c = custoUsd(m.modelo, m.tin, m.tout);
    if (c === null) custoIaCompleto = false; else custoIa += c;
  }

  // Mensagens enviadas (custo da Meta): por categoria de cobrança quando o webhook de status informou
  const { rows: envios } = await pool.query(
    `select coalesce(categoria_cobranca, 'sem_categoria') as categoria, count(*)::int as n
       from crm_mensagens_whatsapp where tenant_id = $1 and direcao = 'enviada' and autor in ('agente', 'humano') and ${periodo}
      group by 1 order by 2 desc`, [tenantId, d]);
  const totalEnviadas = envios.reduce((s, e) => s + e.n, 0);
  const custoMeta = limites.custo_mensagem_meta_usd ? totalEnviadas * Number(limites.custo_mensagem_meta_usd) : null;

  // Custo por conversa (as mais caras primeiro)
  const { rows: porConversa } = await pool.query(
    `select c.id as conversa_id, c.telefone_e164, coalesce(nullif(cl.nome, 'Sem nome'), c.nome_whatsapp) as nome,
            count(e.id)::int as turnos, coalesce(sum(e.tokens_in), 0)::bigint as tin, coalesce(sum(e.tokens_out), 0)::bigint as tout,
            max(e.modelo) as modelo,
            (select count(*)::int from crm_mensagens_whatsapp m where m.tenant_id = c.tenant_id and m.telefone_e164 = c.telefone_e164
                and m.direcao = 'enviada' and m.autor in ('agente', 'humano') and m.criado_em >= now() - make_interval(days => $2)) as msgs_enviadas
       from crm_agente_execucoes e join crm_conversas_whatsapp c on c.tenant_id = e.tenant_id and c.id = e.conversa_id
       left join crm_clientes cl on cl.tenant_id = c.tenant_id and cl.id = c.cliente_id
      where e.tenant_id = $1 and e.${periodo}
      group by c.id, c.telefone_e164, cl.nome, c.nome_whatsapp
      order by sum(coalesce(e.tokens_in, 0) + coalesce(e.tokens_out, 0)) desc limit 20`, [tenantId, d]);

  // Tempo até o primeiro atendimento humano depois do encaminhamento
  const { rows: [tempo] } = await pool.query(
    `with h as (
       select h.id, h.criado_em, c.telefone_e164,
              (select min(m.criado_em) from crm_mensagens_whatsapp m
                where m.tenant_id = h.tenant_id and m.telefone_e164 = c.telefone_e164 and m.autor = 'humano' and m.direcao = 'enviada' and m.criado_em > h.criado_em) as primeira_resposta
         from crm_handoffs h join crm_conversas_whatsapp c on c.tenant_id = h.tenant_id and c.id = h.conversa_id
        where h.tenant_id = $1 and h.${periodo})
     select count(*)::int as total, count(primeira_resposta)::int as respondidos,
            round((avg(extract(epoch from (primeira_resposta - criado_em)) / 60) filter (where primeira_resposta is not null))::numeric, 1) as media_min,
            round((percentile_cont(0.5) within group (order by extract(epoch from (primeira_resposta - criado_em)) / 60) filter (where primeira_resposta is not null))::numeric, 1) as mediana_min
       from h`, [tenantId, d]);

  // Fila atual de encaminhamentos abertos
  const { rows: [fila] } = await pool.query(
    `select count(*)::int as abertos, coalesce(floor(max(extract(epoch from (now() - criado_em)) / 60)), 0)::int as mais_antigo_min
       from crm_handoffs where tenant_id = $1 and status = 'aberto'`, [tenantId]);

  // Tokens de hoje x teto diário
  const { rows: [hoje] } = await pool.query(
    `select coalesce(sum(coalesce(tokens_in, 0) + coalesce(tokens_out, 0)), 0)::bigint as n from crm_agente_execucoes
      where tenant_id = $1 and (criado_em at time zone $2)::date = (now() at time zone $2)::date`, [tenantId, fuso]);
  const tetoTokens = limites.teto_diario_tokens ? Number(limites.teto_diario_tokens) : null;
  const usoTeto = tetoTokens ? Number(hoje.n) / tetoTokens : null;

  const taxaBloqueio = ex.total ? ex.bloqueadas / ex.total : 0;
  const decididas = ex.aprovadas + ex.editadas + ex.descartadas;
  const alertas = [];
  if (usoTeto !== null && usoTeto >= 1) alertas.push({ nivel: 'critico', codigo: 'teto_diario', mensagem: 'Teto diário de uso do agente atingido: novas conversas vão direto para a equipe.' });
  else if (usoTeto !== null && usoTeto >= LIMITE_ALERTA_TETO) alertas.push({ nivel: 'aviso', codigo: 'teto_diario', mensagem: `Uso do teto diário em ${Math.round(usoTeto * 100)}%.` });
  const alvo = limites.tempo_alvo_resposta_min ? Number(limites.tempo_alvo_resposta_min) : null;
  if (alvo && fila.mais_antigo_min > alvo) alertas.push({ nivel: 'aviso', codigo: 'fila_parada', mensagem: `Há encaminhamento esperando há ${fila.mais_antigo_min} min (meta: ${alvo} min).` });
  if (ex.total >= 10 && taxaBloqueio > 0.2) alertas.push({ nivel: 'info', codigo: 'muitos_bloqueios', mensagem: `O filtro agiu em ${Math.round(taxaBloqueio * 100)}% das respostas: vale revisar o prompt.` });

  return {
    periodo_dias: d,
    modelo: cfg ? cfg.modelo_runtime : null,
    execucoes: {
      total: ex.total, conversas: ex.conversas, chamadas_ao_modelo: ex.chamadas_ao_modelo,
      bloqueadas_pelo_filtro: ex.bloqueadas, taxa_bloqueio: Number(taxaBloqueio.toFixed(4)),
    },
    sugestoes: {
      aprovadas: ex.aprovadas, editadas: ex.editadas, descartadas: ex.descartadas,
      taxa_aprovada_sem_edicao: decididas ? Number((ex.aprovadas / decididas).toFixed(4)) : null,
    },
    custo: {
      tokens,
      ia_usd: custoIaCompleto ? Number(custoIa.toFixed(6)) : null, // null = há modelo sem preço cadastrado
      mensagens_enviadas: totalEnviadas,
      mensagens_por_categoria: envios,
      meta_usd_estimado: custoMeta, // null até configurar limites.custo_mensagem_meta_usd (valor oficial da Meta)
    },
    por_conversa: porConversa.map((c) => ({
      conversa_id: c.conversa_id, telefone: c.telefone_e164, nome: c.nome, turnos: c.turnos, msgs_enviadas: c.msgs_enviadas,
      tokens: Number(c.tin) + Number(c.tout), custo_ia_usd: (() => { const v = custoUsd(c.modelo, c.tin, c.tout); return v === null ? null : Number(v.toFixed(6)); })(),
    })),
    atendimento_humano: {
      encaminhamentos: tempo.total, respondidos: tempo.respondidos,
      media_min: tempo.media_min === null ? null : Number(tempo.media_min), mediana_min: tempo.mediana_min === null ? null : Number(tempo.mediana_min),
    },
    fila: { abertos: fila.abertos, mais_antigo_min: fila.mais_antigo_min },
    teto_diario: { tokens_hoje: Number(hoje.n), teto: tetoTokens, uso: usoTeto === null ? null : Number(usoTeto.toFixed(4)) },
    alertas,
  };
}

module.exports = { calcular, LIMITE_ALERTA_TETO };
