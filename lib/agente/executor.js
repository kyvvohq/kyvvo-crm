// Um turno do agente: contexto -> modelo (com ferramentas, máx. 4 iterações)
// -> pós-filtro -> rascunho ou envio. Tudo que importa para a segurança do
// negócio é decidido aqui em código, não no prompt.
const { FERRAMENTAS, executarFerramenta, anexarMidia, transferirParaEquipe } = require('./ferramentas');
const { filtrarResposta, normalizar } = require('./posfiltro');
const { dentroDoHorario } = require('./horario');
const { carregarConhecimento, carregarHistorico, blocoDinamico, montarSystem } = require('./contexto');

const MAX_ITERACOES = 4;
const MAX_TOKENS_RESPOSTA = 1024;
const TIPOS_SEM_TEXTO = new Set(['audio', 'video', 'localizacao', 'figurinha', 'outro']);
// O modelo às vezes avisa a cliente que vai encaminhar sem chamar transferir_para_equipe. Promessa de
// encaminhamento sem handoff é pior que nada: a cliente espera e ninguém vê. Rede de proteção em código.
const PROMETE_ENCAMINHAR = /(vou|vamos|irei)\s+(te\s+)?(encaminhar|repassar|chamar)|passar\s+(\w+\s+){0,3}(para|pra)\s+(a\s+)?(nossa\s+)?equipe|encaminh(ei|ando)|ja\s+chamei|equipe\s+(vai\s+)?(continuar|assumir)/;
const AVISO_FORA_HORARIO = /\brecebi\b|\brecebida\b|proximo\s+(periodo|atendimento)/;
const ENCAMINHAMENTO_PADRAO = 'Vou encaminhar seu caso para a nossa equipe, que continua o atendimento por aqui. 🩵';

async function criarClienteAnthropic() {
  const Anthropic = require('@anthropic-ai/sdk');
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY não configurada');
  const client = new Anthropic();
  return { criarMensagem: (params) => client.messages.create(params) };
}

async function carregarConfig(pool, tenantId) {
  const { rows } = await pool.query('select * from crm_agente_config where tenant_id = $1', [tenantId]);
  return rows[0] || null;
}

async function tokensDeHoje(pool, tenantId, fuso) {
  const { rows } = await pool.query(
    `select coalesce(sum(coalesce(tokens_in, 0) + coalesce(tokens_out, 0)), 0)::bigint as n from crm_agente_execucoes
      where tenant_id = $1 and (criado_em at time zone $2)::date = (now() at time zone $2)::date`, [tenantId, fuso]);
  return Number(rows[0].n);
}

async function registrarExecucao(pool, d) {
  const { rows } = await pool.query(
    `insert into crm_agente_execucoes
       (tenant_id, conversa_id, mensagem_entrada_id, modelo, ferramentas_chamadas, resposta_proposta, resposta_enviada,
        bloqueada_por_filtro, motivo_bloqueio, tokens_in, tokens_out, latencia_ms, resposta_original, aviso_fora_horario)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
    [d.tenantId, d.conversaId, d.mensagemEntradaId, d.modelo, JSON.stringify(d.ferramentas || []), d.proposta || null,
      d.enviada || null, !!d.bloqueada, d.motivoBloqueio || null, d.tokensIn || 0, d.tokensOut || 0, d.latenciaMs || 0, d.original || null, !!d.avisoForaHorario]);
  return rows[0].id;
}

async function numeroDoCanal(pool, tenantId) {
  const { rows } = await pool.query(
    "select phone_number_id from crm_whatsapp_numeros where tenant_id = $1 and status = 'ativo' order by criado_em limit 1", [tenantId]);
  return rows[0] ? rows[0].phone_number_id : null;
}

// Envia (modo automatico) ou apenas propõe (modo rascunho). Fora da janela de
// 24 h não há texto livre: vira encaminhamento.
async function entregar(pool, { config, conversa, tenantId, texto, tokens, modelo, deps }) {
  if (config.modo !== 'automatico') return { enviada: null, motivo: 'rascunho' };
  const janela = conversa.janela_expira_em ? new Date(conversa.janela_expira_em) : null;
  if (!janela || janela <= deps.agora()) return { enviada: null, motivo: 'janela_expirada' };
  const phoneNumberId = await numeroDoCanal(pool, tenantId);
  if (!phoneNumberId) return { enviada: null, motivo: 'sem_canal' };
  const ok = await deps.enviarTexto({ to: conversa.telefone_e164, texto, phoneNumberId });
  if (!ok) return { enviada: null, motivo: 'falha_envio' };
  await pool.query(
    `insert into crm_mensagens_whatsapp (tenant_id, telefone_e164, direcao, tipo, conteudo, autor, tokens_in, tokens_out, modelo, processada_em)
     values ($1, $2, 'enviada', 'texto', $3, 'agente', $4, $5, $6, now())`,
    [tenantId, conversa.telefone_e164, texto, tokens.in, tokens.out, modelo]);
  return { enviada: texto };
}

async function executarTurno({ pool, tenantId, conversa, mensagens }, deps = {}) {
  const d = {
    agora: () => new Date(),
    enviarTexto: require('@kyvvohq/whatsapp').enviarTexto,
    log: console.error,
    ...deps,
  };
  const config = await carregarConfig(pool, tenantId);
  if (!config || config.modo === 'desligado') return { ignorado: true };

  const t0 = Date.now();
  const textos = config.textos || {};
  const ctx = { tenantId, conversaId: conversa.id, config, estado: {} };
  const entradaId = mensagens.length ? mensagens[mensagens.length - 1].id : null;
  const base = { tenantId, conversaId: conversa.id, mensagemEntradaId: entradaId, modelo: config.modelo_runtime };

  const encaminhar = (motivo, resumo) => transferirParaEquipe(pool, ctx, { motivo, resumo });

  // 1) Limites: turnos por conversa e teto diário de tokens. Estourou = pessoa assume, sem chamar o modelo.
  const limites = config.limites || {};
  const maxTurnos = Number(limites.max_turnos) || 20;
  const { rows: [{ n: turnos }] } = await pool.query(
    'select count(*)::int as n from crm_agente_execucoes where tenant_id = $1 and conversa_id = $2', [tenantId, conversa.id]);
  if (turnos >= maxTurnos) {
    await encaminhar('limite_turnos', `A conversa atingiu o limite de ${maxTurnos} turnos do agente.`);
    return { execucaoId: await registrarExecucao(pool, { ...base, motivoBloqueio: 'limite_turnos', latenciaMs: Date.now() - t0 }), limite: 'turnos' };
  }
  if (limites.teto_diario_tokens) {
    const usados = await tokensDeHoje(pool, tenantId, (config.horario_atendimento || {}).fuso || 'America/Sao_Paulo');
    if (usados >= Number(limites.teto_diario_tokens)) {
      await encaminhar('limite_custo', 'Teto diário de uso do agente atingido; a equipe precisa atender.');
      return { execucaoId: await registrarExecucao(pool, { ...base, motivoBloqueio: 'limite_custo', latenciaMs: Date.now() - t0 }), limite: 'custo' };
    }
  }

  // 2) Arquivos recebidos: anexados ao pedido e encaminhados, sem avaliar viabilidade.
  const anexados = await anexarMidia(pool, ctx, mensagens);
  if (anexados > 0) {
    const { rows } = await pool.query("select 1 from crm_handoffs where tenant_id = $1 and conversa_id = $2 and status = 'aberto'", [tenantId, conversa.id]);
    if (!rows.length) await encaminhar('arquivo_recebido', `A cliente enviou ${anexados} arquivo(s), anexados ao pedido rascunho.`);
  }

  // 3) Só áudio/vídeo/localização/figurinha: pede texto, sem modelo.
  if (mensagens.length && mensagens.every((m) => TIPOS_SEM_TEXTO.has(m.tipo))) {
    const texto = textos.somente_texto || 'Recebi seu envio! Pode me escrever por texto o que você precisa? Assim consigo anotar certinho para a equipe.';
    await encaminhar('midia_nao_suportada', `A cliente enviou ${mensagens.map((m) => m.tipo).join(', ')}; pedi que escreva por texto.`);
    const r = await entregar(pool, { config, conversa, tenantId, texto, tokens: { in: 0, out: 0 }, modelo: null, deps: d });
    return { execucaoId: await registrarExecucao(pool, { ...base, modelo: null, proposta: texto, enviada: r.enviada, latenciaMs: Date.now() - t0 }), resposta: texto };
  }

  // 4) Modelo com ferramentas.
  const ia = d.ia || await criarClienteAnthropic();
  const conhecimento = await carregarConhecimento(pool, tenantId);
  const dinamico = await blocoDinamico(pool, { tenantId, conversa, config, agora: d.agora() });
  const system = montarSystem({ sistema: conhecimento.sistema, base: conhecimento.base, dinamico });
  const historico = await carregarHistorico(pool, tenantId, conversa.telefone_e164);
  if (!historico.length) throw new Error('sem mensagem da cliente para responder');

  const chamadas = [];
  const tokens = { in: 0, out: 0 };
  let textoFinal = null;
  let recusou = false;
  let msgs = historico;
  for (let i = 0; i < MAX_ITERACOES; i += 1) {
    const params = { model: config.modelo_runtime, max_tokens: MAX_TOKENS_RESPOSTA, system, tools: FERRAMENTAS, messages: msgs };
    if (i === MAX_ITERACOES - 1) params.tool_choice = { type: 'none' }; // última volta: só texto
    const resp = await ia.criarMensagem(params);
    const u = resp.usage || {};
    tokens.in += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    tokens.out += u.output_tokens || 0;

    if (resp.stop_reason === 'refusal') { recusou = true; break; }
    if (resp.stop_reason === 'tool_use') {
      const resultados = [];
      for (const bloco of resp.content.filter((b) => b.type === 'tool_use')) {
        let conteudo; let erro = false;
        try {
          conteudo = JSON.stringify(await executarFerramenta(pool, ctx, bloco.name, bloco.input));
        } catch (e) {
          conteudo = e.message; erro = true;
        }
        chamadas.push({ nome: bloco.name, input: bloco.input, erro });
        resultados.push({ type: 'tool_result', tool_use_id: bloco.id, content: conteudo, ...(erro ? { is_error: true } : {}) });
      }
      // conteúdo do assistente volta inteiro (inclui blocos de raciocínio, se houver)
      msgs = [...msgs, { role: 'assistant', content: resp.content }, { role: 'user', content: resultados }];
      continue;
    }
    textoFinal = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || null;
    break;
  }

  // 5) Pós-filtro e fallback de encaminhamento.
  let resposta = textoFinal;
  let bloqueada = false;
  let motivoBloqueio = null;
  if (recusou || !resposta) {
    bloqueada = true;
    motivoBloqueio = recusou ? 'recusa_do_modelo' : 'sem_resposta';
    if (!ctx.estado.transferiu) await encaminhar('falha_agente', `O agente não produziu resposta (${motivoBloqueio}).`);
    resposta = textos.encaminhamento || ENCAMINHAMENTO_PADRAO;
  } else {
    const f = filtrarResposta(resposta, { fraseVip: textos.desconto_vip, vipConfirmado: ctx.estado.vipVerificado === true });
    if (!f.ok) {
      bloqueada = true;
      motivoBloqueio = f.motivos.join(',');
      await encaminhar('bloqueio_filtro', `Resposta do agente bloqueada pelo filtro (${motivoBloqueio}). A cliente precisa de retorno da equipe.`);
      resposta = textos.encaminhamento || ENCAMINHAMENTO_PADRAO;
    }
  }

  // 5b) Rede de proteção: prometeu encaminhar sem handoff -> cria o handoff.
  if (!bloqueada && !ctx.estado.transferiu && PROMETE_ENCAMINHAR.test(normalizar(resposta))) {
    const { rows } = await pool.query("select 1 from crm_handoffs where tenant_id = $1 and conversa_id = $2 and status = 'aberto'", [tenantId, conversa.id]);
    if (!rows.length) {
      const ultima = mensagens.length ? String(mensagens[mensagens.length - 1].conteudo || '').slice(0, 200) : '';
      await encaminhar('outro', `O agente avisou a cliente que encaminharia, sem registrar o motivo. Última mensagem dela: "${ultima}"`);
      chamadas.push({ nome: 'transferir_para_equipe', input: { motivo: 'outro' }, erro: false, implicito: true });
    }
  }

  // 5c) Fora do horário: o aviso de recebimento sai uma vez por período (12 h), mesmo se o modelo esquecer.
  const original = textoFinal;
  let avisoForaHorario = false;
  if (!bloqueada && !dentroDoHorario(config.horario_atendimento, d.agora())) {
    if (AVISO_FORA_HORARIO.test(normalizar(resposta))) avisoForaHorario = true;
    else {
      const { rows } = await pool.query(
        "select 1 from crm_agente_execucoes where tenant_id = $1 and conversa_id = $2 and aviso_fora_horario and criado_em > now() - interval '12 hours' limit 1", [tenantId, conversa.id]);
      if (!rows.length && config.mensagem_fora_horario) { resposta = `${config.mensagem_fora_horario}

${resposta}`; avisoForaHorario = true; }
    }
  }

  // 6) Rascunho propõe; automático envia (dentro da janela de 24 h).
  const r = await entregar(pool, { config, conversa, tenantId, texto: resposta, tokens, modelo: config.modelo_runtime, deps: d });
  if (r.motivo === 'janela_expirada') await encaminhar('janela_expirada', 'A janela de 24 h da conversa expirou; resposta não enviada.');
  const execucaoId = await registrarExecucao(pool, {
    ...base, ferramentas: chamadas, proposta: resposta, enviada: r.enviada, bloqueada, motivoBloqueio, original, avisoForaHorario,
    tokensIn: tokens.in, tokensOut: tokens.out, latenciaMs: Date.now() - t0,
  });
  return { execucaoId, resposta, bloqueada, original, enviada: r.enviada, ferramentas: chamadas };
}

module.exports = { executarTurno, criarClienteAnthropic, MAX_ITERACOES };
