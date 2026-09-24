// Bot conversacional de atendimento por WhatsApp — primeiro caso: Basic 3D
// Print (briefing do Bruno, 2026-09-24). Fluxo fixo e sequencial (sem IA,
// sem n8n — diferente do bot do Studio): saudação com 2 opções, opção 1
// segue com 7 perguntas fixas e cria cliente+pedido no fim; opção 2 só
// agradece e encerra. Estado da conversa persistido em
// crm_conversas_whatsapp — cada mensagem recebida avança um passo.
const { encontrarOuCriarPorTelefone } = require('./clientes');

const SAUDACAO = `Olá! 👋 Este é o canal de atendimento da Basic 3D Print para pedidos personalizados. Ficamos muito felizes em te receber por aqui!

Temos alguns pedidos em pronta entrega que possa te atender de imediato, vale a pena conferir em nossas lojas oficiais:

https://shopee.com.br/basic3dprint
https://www.tiktok.com/discover/basic3dprint
https://perfil.mercadolivre.com.br/BASIC3DPRINT

Me conta como posso te ajudar hoje:
1️⃣ Já olhei mas ainda quero um fazer um pedido
2️⃣ Encontrei pelas lojas.

É só responder com o número. 😊`;

const MENSAGEM_OPCAO_INVALIDA = 'Não entendi 🤔 Responde só com *1* ou *2*, por favor.';
const MENSAGEM_AGRADECIMENTO = 'Que bom que você já encontrou! 😊 Qualquer dúvida é só chamar por aqui. Obrigado por escolher a Basic 3D Print!';

// Ordem fixa (briefing do Bruno): tipo da peça, largura, altura, comprimento,
// formato (quadrado/redondo), borda (com/sem) e cor.
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
// de pedido no kanban) e um pedido em texto livre com o resumo das 7
// respostas — sem preço (a Basic combina valor/prazo depois, o bot só
// capta o pedido). Best-effort: se a conta não tiver etapa 'aberta'
// configurada (não devia acontecer, inicializarEtapasPadrao já roda no
// onboarding), loga e segue sem travar a confirmação pro cliente.
async function criarPedidoDoBot(pool, tenantId, telefoneE164, respostas) {
  const { rows: etapaRows } = await pool.query(
    `select id from crm_etapas where tenant_id = $1 and tipo = 'aberta' order by ordem asc limit 1`,
    [tenantId]
  );
  if (!etapaRows[0]) {
    console.error(`[bot-whatsapp] tenant ${tenantId} sem etapa 'aberta' — pedido do bot não foi criado (cliente ainda foi cadastrado).`);
    return null;
  }

  const cliente = await encontrarOuCriarPorTelefone(pool, tenantId, { telefone: telefoneE164, origem: 'whatsapp' });
  const descricao = `${respostas.tipo_peca} — ${respostas.largura}x${respostas.altura}x${respostas.comprimento}cm, `
    + `formato ${respostas.formato}, ${respostas.borda}, cor ${respostas.cor}`;

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
      [tenantId, cliente.id, pedido.id, JSON.stringify({ origem: 'bot_whatsapp', respostas })]
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

function mensagemConfirmacao(respostas) {
  return `Perfeito! Anotei tudo aqui:

🔹 Peça: ${respostas.tipo_peca}
🔹 Medidas: ${respostas.largura} x ${respostas.altura} x ${respostas.comprimento} cm
🔹 Formato: ${respostas.formato}
🔹 Borda: ${respostas.borda}
🔹 Cor: ${respostas.cor}

Já registrei seu pedido por aqui e nossa equipe vai te chamar em breve pra confirmar valor e prazo. Obrigado por escolher a Basic 3D Print! 🙌`;
}

// Processa 1 mensagem de texto recebida e devolve a(s) resposta(s) a
// enviar de volta — não manda mensagem nenhuma sozinho (quem chama decide
// como enviar, ver routes de webhook), só decide o texto e persiste o
// avanço de estado.
async function processarMensagem(pool, { tenantId, telefoneE164, texto }) {
  const conversa = await buscarConversa(pool, tenantId, telefoneE164);
  const mensagemLimpa = String(texto || '').trim();

  if (!conversa) {
    await salvarConversa(pool, tenantId, telefoneE164, { estado: 'aguardando_opcao', respostas: {} });
    return [SAUDACAO];
  }

  if (conversa.estado === 'aguardando_opcao') {
    if (mensagemLimpa.includes('1')) {
      await salvarConversa(pool, tenantId, telefoneE164, { estado: estadoDaPergunta(0), respostas: {} });
      return [PERGUNTAS[0].texto];
    }
    if (mensagemLimpa.includes('2')) {
      await encerrarConversa(pool, tenantId, telefoneE164);
      return [MENSAGEM_AGRADECIMENTO];
    }
    return [MENSAGEM_OPCAO_INVALIDA];
  }

  const match = /^pergunta_(\d+)$/.exec(conversa.estado);
  const indiceAtual = match ? Number(match[1]) : -1;
  if (indiceAtual < 0 || indiceAtual >= PERGUNTAS.length) {
    // Estado desconhecido (dado corrompido/versão antiga) — reinicia do zero
    // em vez de travar a conversa pro cliente pra sempre.
    await encerrarConversa(pool, tenantId, telefoneE164);
    return [];
  }

  const respostas = { ...conversa.respostas, [PERGUNTAS[indiceAtual].chave]: mensagemLimpa };
  const proximoIndice = indiceAtual + 1;

  if (proximoIndice < PERGUNTAS.length) {
    await salvarConversa(pool, tenantId, telefoneE164, { estado: estadoDaPergunta(proximoIndice), respostas });
    return [PERGUNTAS[proximoIndice].texto];
  }

  await encerrarConversa(pool, tenantId, telefoneE164);
  try {
    await criarPedidoDoBot(pool, tenantId, telefoneE164, respostas);
  } catch (erro) {
    console.error(`[bot-whatsapp] Falha ao criar pedido pra ${telefoneE164} (tenant ${tenantId}): ${erro.message}`);
  }
  return [mensagemConfirmacao(respostas)];
}

module.exports = { processarMensagem, SAUDACAO, PERGUNTAS };
