// Bot conversacional de atendimento por WhatsApp — primeiro caso: Basic 3D
// Print (briefing do Bruno, 2026-09-24, revisado 2026-09-24 pra usar botões
// nativos do WhatsApp — "interactive/button" — em vez de menu numerado).
// Fluxo fixo e sequencial (sem IA, sem n8n — diferente do bot do Studio).
// Estado da conversa persistido em crm_conversas_whatsapp — cada mensagem
// recebida avança um passo.
const { encontrarOuCriarPorTelefone } = require('./clientes');

function envioTexto(texto) {
  return { tipo: 'texto', texto };
}
function envioBotoes(texto, botoes) {
  return { tipo: 'botoes', texto, botoes };
}

const SAUDACAO_TEXTO = 'Olá! 👋 Seja bem-vindo(a) à *Basic 3D Print*! 💙\n\n'
  + 'Trabalhamos com *impressões 3D personalizadas* e produtos à pronta entrega.\n\n'
  + 'Como podemos te ajudar?';
const SAUDACAO_BOTOES = [
  { id: 'fazer_pedido', titulo: 'Fazer pedido' },
  { id: 'ver_lojas', titulo: 'Ver lojas' },
];

const PERGUNTA_ARQUIVO_TEXTO = 'Perfeito! 😊 Vamos preparar seu pedido.\n\n'
  + 'Você já possui o arquivo do modelo que deseja imprimir?';
const PERGUNTA_ARQUIVO_BOTOES = [
  { id: 'tem_arquivo', titulo: 'Tenho um arquivo' },
  { id: 'sem_arquivo', titulo: 'Não tenho um arquivo' },
];

const MENSAGEM_LOJAS = 'Legal! 😊 Você pode conferir nossos produtos à pronta entrega em nossas lojas oficiais:\n\n'
  + '🛒 Shopee: https://shopee.com.br/basic3dprint\n'
  + '🎵 TikTok: https://www.tiktok.com/discover/basic3dprint\n'
  + '🛍️ Mercado Livre: https://perfil.mercadolivre.com.br/BASIC3DPRINT';

const MENSAGEM_PEDIR_ARQUIVO = 'Show! 📎 Pode mandar o arquivo aqui mesmo pelo WhatsApp (STL, OBJ ou similar).';
const MENSAGEM_ARQUIVO_RECEBIDO = 'Arquivo recebido! ✅\n\nQual *cor* você prefere?';
const MENSAGEM_PERGUNTA_QUANTIDADE = 'E qual a *quantidade* de peças?';
const MENSAGEM_MANDE_O_ARQUIVO = 'Ainda não recebi nenhum arquivo — pode anexar o arquivo (STL, OBJ ou similar) aqui na conversa?';

// Ordem fixa do fluxo "não tenho arquivo" (briefing original): tipo da
// peça, largura, altura, comprimento, formato (quadrado/redondo), borda
// (com/sem) e cor.
const PERGUNTAS = [
  { chave: 'tipo_peca', texto: 'Show! Vamos lá 😄\n\nQual o *tipo da peça* que você quer? (ex: vaso, luminária, suporte, miniatura...)' },
  { chave: 'largura', texto: 'Qual a *largura* da peça, em cm?' },
  { chave: 'altura', texto: 'E a *altura*, em cm?' },
  { chave: 'comprimento', texto: 'E o *comprimento*, em cm?' },
  { chave: 'formato', texto: 'O formato é *quadrado* ou *redondo*?' },
  { chave: 'borda', texto: 'Você quer *com borda* ou *sem borda*?' },
  { chave: 'cor', texto: 'Por último: qual *cor* você prefere?' },
];

function estadoDaPergunta(indice) {
  return `pergunta_${indice}`;
}

async function buscarConversa(pool, tenantId, telefoneE164) {
  const { rows } = await pool.query(
    'select * from crm_conversas_whatsapp where tenant_id = $1 and telefone_e164 = $2',
    [tenantId, telefoneE164]
  );
  return rows[0] || null;
}

async function salvarConversa(pool, tenantId, telefoneE164, { estado, respostas }) {
  await pool.query(
    `insert into crm_conversas_whatsapp (tenant_id, telefone_e164, estado, respostas)
     values ($1, $2, $3, $4)
     on conflict (tenant_id, telefone_e164) do update
       set estado = excluded.estado, respostas = excluded.respostas, atualizado_em = now()`,
    [tenantId, telefoneE164, estado, JSON.stringify(respostas)]
  );
}

async function encerrarConversa(pool, tenantId, telefoneE164) {
  await pool.query('delete from crm_conversas_whatsapp where tenant_id = $1 and telefone_e164 = $2', [tenantId, telefoneE164]);
}

// Cria o cliente (acha-ou-cria por telefone, mesma lógica da criação rápida
// de pedido no kanban) e um pedido em texto livre — sem preço (a Basic
// combina valor/prazo depois, o bot só capta o pedido). Best-effort: se a
// conta não tiver etapa 'aberta' configurada (não devia acontecer,
// inicializarEtapasPadrao já roda no onboarding), loga e segue sem travar a
// confirmação pro cliente.
async function criarPedido(pool, tenantId, telefoneE164, { descricao, dadosEvento }) {
  const { rows: etapaRows } = await pool.query(
    `select id from crm_etapas where tenant_id = $1 and tipo = 'aberta' order by ordem asc limit 1`,
    [tenantId]
  );
  if (!etapaRows[0]) {
    console.error(`[bot-whatsapp] tenant ${tenantId} sem etapa 'aberta' — pedido do bot não foi criado (cliente ainda foi cadastrado).`);
    return null;
  }

  const cliente = await encontrarOuCriarPorTelefone(pool, tenantId, { telefone: telefoneE164, origem: 'whatsapp' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: pedidoRows } = await client.query(
      `insert into crm_pedidos (tenant_id, cliente_id, etapa_id, origem) values ($1, $2, $3, 'whatsapp') returning *`,
      [tenantId, cliente.id, etapaRows[0].id]
    );
    const pedido = pedidoRows[0];
    await client.query(
      `insert into crm_pedidos_itens (pedido_id, descricao, quantidade, valor_unitario) values ($1, $2, 1, 0)`,
      [pedido.id, descricao]
    );
    await client.query(
      `insert into crm_eventos (tenant_id, cliente_id, pedido_id, tipo, dados) values ($1, $2, $3, 'criacao', $4)`,
      [tenantId, cliente.id, pedido.id, JSON.stringify({ origem: 'bot_whatsapp', ...dadosEvento })]
    );
    await client.query('COMMIT');
    return pedido;
  } catch (erro) {
    await client.query('ROLLBACK');
    throw erro;
  } finally {
    client.release();
  }
}

function mensagemConfirmacaoSemArquivo(respostas) {
  return `Perfeito! Anotei tudo aqui:

🔹 Peça: ${respostas.tipo_peca}
🔹 Medidas: ${respostas.largura} x ${respostas.altura} x ${respostas.comprimento} cm
🔹 Formato: ${respostas.formato}
🔹 Borda: ${respostas.borda}
🔹 Cor: ${respostas.cor}

Já registrei seu pedido por aqui e nossa equipe vai te chamar em breve pra confirmar valor e prazo. Obrigado por escolher a Basic 3D Print! 🙌`;
}

function mensagemConfirmacaoComArquivo(respostas) {
  return `Perfeito! Anotei tudo aqui:

🔹 Arquivo: ${respostas.nomeArquivo}
🔹 Cor: ${respostas.cor}
🔹 Quantidade: ${respostas.quantidade}

Já registrei seu pedido por aqui e nossa equipe vai te chamar em breve pra confirmar valor e prazo. Obrigado por escolher a Basic 3D Print! 🙌`;
}

// Processa 1 mensagem recebida (texto, clique de botão ou arquivo) e
// devolve a(s) mensagem(ns) a enviar de volta (cada uma já no formato
// {tipo:'texto',...} ou {tipo:'botoes',...}) — não manda nada sozinho, só
// decide o conteúdo e persiste o avanço de estado.
//
// `entrada`: { tipo: 'texto', texto } | { tipo: 'botao', id } | { tipo: 'arquivo', mediaId, nomeArquivo }
async function processarMensagem(pool, { tenantId, telefoneE164, entrada }) {
  const conversa = await buscarConversa(pool, tenantId, telefoneE164);

  if (!conversa) {
    await salvarConversa(pool, tenantId, telefoneE164, { estado: 'aguardando_opcao', respostas: {} });
    return [envioBotoes(SAUDACAO_TEXTO, SAUDACAO_BOTOES)];
  }

  if (conversa.estado === 'aguardando_opcao') {
    if (entrada.tipo === 'botao' && entrada.id === 'fazer_pedido') {
      await salvarConversa(pool, tenantId, telefoneE164, { estado: 'aguardando_arquivo', respostas: {} });
      return [envioBotoes(PERGUNTA_ARQUIVO_TEXTO, PERGUNTA_ARQUIVO_BOTOES)];
    }
    if (entrada.tipo === 'botao' && entrada.id === 'ver_lojas') {
      await encerrarConversa(pool, tenantId, telefoneE164);
      return [envioTexto(MENSAGEM_LOJAS)];
    }
    return [envioBotoes(SAUDACAO_TEXTO, SAUDACAO_BOTOES)];
  }

  if (conversa.estado === 'aguardando_arquivo') {
    if (entrada.tipo === 'botao' && entrada.id === 'tem_arquivo') {
      await salvarConversa(pool, tenantId, telefoneE164, { estado: 'aguardando_envio_arquivo', respostas: {} });
      return [envioTexto(MENSAGEM_PEDIR_ARQUIVO)];
    }
    if (entrada.tipo === 'botao' && entrada.id === 'sem_arquivo') {
      await salvarConversa(pool, tenantId, telefoneE164, { estado: estadoDaPergunta(0), respostas: {} });
      return [envioTexto(PERGUNTAS[0].texto)];
    }
    return [envioBotoes(PERGUNTA_ARQUIVO_TEXTO, PERGUNTA_ARQUIVO_BOTOES)];
  }

  if (conversa.estado === 'aguardando_envio_arquivo') {
    if (entrada.tipo === 'arquivo') {
      const respostas = { nomeArquivo: entrada.nomeArquivo || entrada.mediaId, mediaId: entrada.mediaId };
      await salvarConversa(pool, tenantId, telefoneE164, { estado: 'pergunta_cor_arquivo', respostas });
      return [envioTexto(MENSAGEM_ARQUIVO_RECEBIDO)];
    }
    return [envioTexto(MENSAGEM_MANDE_O_ARQUIVO)];
  }

  if (conversa.estado === 'pergunta_cor_arquivo') {
    const texto = entrada.tipo === 'texto' ? entrada.texto.trim() : '';
    const respostas = { ...conversa.respostas, cor: texto };
    await salvarConversa(pool, tenantId, telefoneE164, { estado: 'pergunta_quantidade_arquivo', respostas });
    return [envioTexto(MENSAGEM_PERGUNTA_QUANTIDADE)];
  }

  if (conversa.estado === 'pergunta_quantidade_arquivo') {
    const texto = entrada.tipo === 'texto' ? entrada.texto.trim() : '';
    const respostas = { ...conversa.respostas, quantidade: texto };
    await encerrarConversa(pool, tenantId, telefoneE164);
    try {
      await criarPedido(pool, tenantId, telefoneE164, {
        descricao: `Arquivo: ${respostas.nomeArquivo} — cor ${respostas.cor}, quantidade ${respostas.quantidade}`,
        dadosEvento: respostas,
      });
    } catch (erro) {
      console.error(`[bot-whatsapp] Falha ao criar pedido (com arquivo) pra ${telefoneE164} (tenant ${tenantId}): ${erro.message}`);
    }
    return [envioTexto(mensagemConfirmacaoComArquivo(respostas))];
  }

  const match = /^pergunta_(\d+)$/.exec(conversa.estado);
  const indiceAtual = match ? Number(match[1]) : -1;
  if (indiceAtual < 0 || indiceAtual >= PERGUNTAS.length) {
    // Estado desconhecido (dado corrompido/versão antiga) — reinicia do zero
    // em vez de travar a conversa pro cliente pra sempre.
    await encerrarConversa(pool, tenantId, telefoneE164);
    return [];
  }

  const textoRecebido = entrada.tipo === 'texto' ? entrada.texto.trim() : '';
  const respostas = { ...conversa.respostas, [PERGUNTAS[indiceAtual].chave]: textoRecebido };
  const proximoIndice = indiceAtual + 1;

  if (proximoIndice < PERGUNTAS.length) {
    await salvarConversa(pool, tenantId, telefoneE164, { estado: estadoDaPergunta(proximoIndice), respostas });
    return [envioTexto(PERGUNTAS[proximoIndice].texto)];
  }

  await encerrarConversa(pool, tenantId, telefoneE164);
  try {
    await criarPedido(pool, tenantId, telefoneE164, {
      descricao: `${respostas.tipo_peca} — ${respostas.largura}x${respostas.altura}x${respostas.comprimento}cm, `
        + `formato ${respostas.formato}, ${respostas.borda}, cor ${respostas.cor}`,
      dadosEvento: respostas,
    });
  } catch (erro) {
    console.error(`[bot-whatsapp] Falha ao criar pedido pra ${telefoneE164} (tenant ${tenantId}): ${erro.message}`);
  }
  return [envioTexto(mensagemConfirmacaoSemArquivo(respostas))];
}

module.exports = { processarMensagem, SAUDACAO_TEXTO, SAUDACAO_BOTOES, PERGUNTAS };
