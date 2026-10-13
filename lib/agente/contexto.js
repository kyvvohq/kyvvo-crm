// Monta o que o modelo enxerga: histórico recente (sem CPF/CNPJ), o bloco de
// contexto dinâmico e as camadas fixas do prompt. Dado pessoal mínimo: só o
// primeiro nome da cliente; telefone, e-mail, CPF e endereço nunca entram.
const { higienizarEntrada } = require('./posfiltro');
const { dentroDoHorario } = require('./horario');

const ORDEM_CONHECIMENTO = ['voz', 'regras', 'fluxo', 'casos', 'respostas'];
const HISTORICO_MAX = 30;

async function carregarConhecimento(pool, tenantId) {
  const { rows } = await pool.query('select tipo, conteudo_md from crm_agente_conhecimento where tenant_id = $1 and ativo', [tenantId]);
  const porTipo = Object.fromEntries(rows.map((r) => [r.tipo, r.conteudo_md]));
  return {
    sistema: porTipo.sistema || '',
    base: ORDEM_CONHECIMENTO.filter((t) => porTipo[t]).map((t) => `<${t}>\n${porTipo[t]}\n</${t}>`).join('\n\n'),
  };
}

function textoDaMensagem(m) {
  if ((m.tipo === 'imagem' || m.tipo === 'documento') && m.anexo_id) {
    const legenda = m.conteudo && !m.conteudo.startsWith('[') ? ` Legenda: ${m.conteudo}` : '';
    return `[${m.tipo} recebido e anexado ao pedido]${legenda}`;
  }
  if (['audio', 'video', 'localizacao', 'figurinha'].includes(m.tipo)) return `[a cliente enviou ${m.tipo}, que não é interpretado]`;
  return higienizarEntrada(m.conteudo);
}

// Histórico -> messages da API: user/assistant alternando, começando por user.
async function carregarHistorico(pool, tenantId, telefone) {
  const { rows } = await pool.query(
    `select direcao, tipo, conteudo, anexo_id from crm_mensagens_whatsapp
      where tenant_id = $1 and telefone_e164 = $2 and direcao in ('recebida', 'enviada')
      order by criado_em desc, id desc limit $3`, [tenantId, telefone, HISTORICO_MAX]);
  const out = [];
  for (const m of rows.reverse()) {
    const role = m.direcao === 'recebida' ? 'user' : 'assistant';
    const texto = textoDaMensagem(m);
    if (!texto) continue;
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += `\n${texto}`;
    else out.push({ role, content: texto });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
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

function montarSystem({ sistema, base, dinamico }) {
  const blocos = [{ type: 'text', text: sistema }];
  if (base) blocos.push({ type: 'text', text: `Base de conhecimento da conta:\n\n${base}`, cache_control: { type: 'ephemeral' } });
  else blocos[0].cache_control = { type: 'ephemeral' };
  blocos.push({ type: 'text', text: dinamico });
  return blocos;
}

module.exports = { carregarConhecimento, carregarHistorico, blocoDinamico, montarSystem, textoDaMensagem, HISTORICO_MAX };
