// Bot conversacional de atendimento por WhatsApp — primeiro caso: Basic 3D
// Print (briefing do Bruno, 2026-09-24, revisado no mesmo dia: botões
// nativos + coleta de arquivo(s)/referência, quantidade validada e
// endereço de entrega). Fluxo fixo e sequencial (sem IA, sem n8n —
// diferente do bot do Studio). Estado da conversa persistido em
// crm_conversas_whatsapp — cada mensagem recebida avança um passo.
const { encontrarOuCriarPorTelefone } = require('./clientes');
const whatsappMedia = require('./whatsapp-media');

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

const MENSAGEM_PEDIR_ARQUIVOS = 'Show! 📎 Pode mandar o(s) arquivo(s) aqui mesmo pelo WhatsApp (STL, OBJ, foto, PDF etc).\n\n'
  + 'Quando terminar de enviar, digite *pronto*.';
const MENSAGEM_ARQUIVO_RECEBIDO_LOOP = 'Arquivo recebido! ✅ Pode mandar mais um, ou digite *pronto* quando terminar.';
const MENSAGEM_PRECISA_1_ARQUIVO = 'Preciso de pelo menos 1 arquivo — manda o arquivo, por favor, ou digite *pronto* depois de enviar.';
const MENSAGEM_ENTRADA_NAO_RECONHECIDA_ARQUIVO = 'Não recebi nenhum arquivo aí 🤔 Pode mandar o arquivo, ou digitar *pronto* se já terminou de enviar.';
const MENSAGEM_FALHA_BAIXAR_ARQUIVO = 'Ih, não consegui baixar esse arquivo agora 😕 Pode tentar mandar de novo?';

const PERGUNTA_COR = 'Qual *cor* você prefere?';
const PERGUNTA_REFERENCIA = 'Perfeito! 😊 Me manda uma *referência ou foto* do que você quer?';
const PERGUNTA_QUANTIDADE = 'Quantas *peças* você quer?';
const MENSAGEM_QUANTIDADE_INVALIDA = 'A quantidade precisa ser um número inteiro de pelo menos 1. Quantas peças você quer?';

const PERGUNTA_CEP = 'Pra gente entregar, qual o *CEP* do endereço de entrega?';
const PERGUNTA_NUMERO = 'Qual o *número* da casa/apto?';
const PERGUNTA_COMPLEMENTO = 'Tem complemento? (bloco, apto, ponto de referência...) Se não tiver, responde *não*.';

const RESPOSTAS_SEM_COMPLEMENTO = ['nao', 'não', 'n/a', 'na', '-'];

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

// CEP + número já cadastrados = não precisa perguntar de novo (complemento
// é opcional, não entra nessa checagem).
async function clienteTemEnderecoCompleto(pool, tenantId, telefoneE164) {
  const { rows } = await pool.query('select cep, numero from crm_clientes where tenant_id = $1 and telefone = $2', [tenantId, telefoneE164]);
  const c = rows[0];
  return !!(c && c.cep && c.numero);
}

function mensagemConfirmacao(respostas) {
  const linhas = respostas.tipoFluxo === 'com_arquivo'
    ? [
      `🔹 Arquivo(s): ${respostas.arquivos.map((a) => a.nomeArquivo).join(', ')}`,
      `🔹 Cor: ${respostas.cor}`,
    ]
    : [`🔹 Referência: ${respostas.referenciaTexto || respostas.referenciaArquivo}`];

  linhas.push(`🔹 Quantidade: ${respostas.quantidade}`);
  if (respostas.cep) linhas.push(`🔹 Entrega: CEP ${respostas.cep}, nº ${respostas.numero}${respostas.complemento ? `, ${respostas.complemento}` : ''}`);

  return `Perfeito! Anotei tudo aqui:\n\n${linhas.join('\n')}\n\n`
    + 'Já registrei seu pedido por aqui e nossa equipe vai te chamar em breve pra confirmar valor e prazo. Obrigado por escolher a Basic 3D Print! 🙌';
}

// Acha-ou-cria o cliente (nome do WhatsApp quando é cadastro novo — nunca
// sobrescreve nome de cliente já existente), atualiza endereço se coletado
// nesta conversa, cria o pedido (com itens/arquivos conforme o fluxo).
// Best-effort: se a conta não tiver etapa 'aberta' configurada (não devia
// acontecer, inicializarEtapasPadrao já roda no onboarding), loga e segue
// sem travar a confirmação pro cliente.
async function finalizarPedido(pool, tenantId, telefoneE164, nomeWhatsapp, respostas) {
  const { rows: etapaRows } = await pool.query(
    `select id from crm_etapas where tenant_id = $1 and tipo = 'aberta' order by ordem asc limit 1`,
    [tenantId]
  );
  if (!etapaRows[0]) {
    console.error(`[bot-whatsapp] tenant ${tenantId} sem etapa 'aberta' — pedido do bot não foi criado (cliente ainda foi cadastrado).`);
    return null;
  }

  const cliente = await encontrarOuCriarPorTelefone(pool, tenantId, { telefone: telefoneE164, nome: nomeWhatsapp, origem: 'whatsapp' });

  if (respostas.cep) {
    await pool.query(
      'update crm_clientes set cep = $1, numero = $2, complemento = $3, atualizado_em = now() where id = $4',
      [respostas.cep, respostas.numero, respostas.complemento || null, cliente.id]
    );
  }

  const descricao = respostas.tipoFluxo === 'com_arquivo'
    ? `Arquivo(s): ${respostas.arquivos.map((a) => a.nomeArquivo).join(', ')} — cor ${respostas.cor}`
    : `Referência: ${respostas.referenciaTexto || respostas.referenciaArquivo}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: pedidoRows } = await client.query(
      `insert into crm_pedidos (tenant_id, cliente_id, etapa_id, origem) values ($1, $2, $3, 'whatsapp') returning *`,
      [tenantId, cliente.id, etapaRows[0].id]
    );
    const pedido = pedidoRows[0];
    await client.query(
      `insert into crm_pedidos_itens (pedido_id, descricao, quantidade, valor_unitario) values ($1, $2, $3, 0)`,
      [pedido.id, descricao, respostas.quantidade]
    );
    for (const arquivo of respostas.arquivos || []) {
      await client.query(
        `insert into crm_pedidos_arquivos (pedido_id, nome_arquivo, caminho_arquivo, tipo_mime, media_id_whatsapp)
         values ($1, $2, $3, $4, $5)`,
        [pedido.id, arquivo.nomeArquivo, arquivo.caminhoArquivo, arquivo.tipoMime, arquivo.mediaId]
      );
    }
    await client.query(
      `insert into crm_eventos (tenant_id, cliente_id, pedido_id, tipo, dados) values ($1, $2, $3, 'criacao', $4)`,
      [tenantId, cliente.id, pedido.id, JSON.stringify({ origem: 'bot_whatsapp', ...respostas })]
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

// Depois da quantidade validada (comum aos dois fluxos): pula pra entrega
// se o cliente já tem endereço, senão pergunta CEP.
async function avancarParaEnderecoOuFinalizar(pool, tenantId, telefoneE164, nomeWhatsapp, respostas) {
  const temEndereco = await clienteTemEnderecoCompleto(pool, tenantId, telefoneE164);
  if (temEndereco) {
    await encerrarConversa(pool, tenantId, telefoneE164);
    try {
      await finalizarPedido(pool, tenantId, telefoneE164, nomeWhatsapp, respostas);
    } catch (erro) {
      console.error(`[bot-whatsapp] Falha ao criar pedido pra ${telefoneE164} (tenant ${tenantId}): ${erro.message}`);
    }
    return [envioTexto(mensagemConfirmacao(respostas))];
  }
  await salvarConversa(pool, tenantId, telefoneE164, { estado: 'pergunta_cep', respostas });
  return [envioTexto(PERGUNTA_CEP)];
}

// Processa 1 mensagem recebida (texto, clique de botão ou arquivo) e
// devolve a(s) mensagem(ns) a enviar de volta (cada uma já no formato
// {tipo:'texto',...} ou {tipo:'botoes',...}) — não manda nada sozinho, só
// decide o conteúdo e persiste o avanço de estado.
//
// `entrada`: { tipo: 'texto', texto } | { tipo: 'botao', id } | { tipo: 'arquivo', mediaId, nomeArquivo }
// `nomeWhatsapp`: nome do perfil do contato no WhatsApp (Meta manda em
// quase toda mensagem) — usado só se o cliente ainda não tiver cadastro.
async function processarMensagem(pool, { tenantId, telefoneE164, entrada, nomeWhatsapp, baixarMidia = whatsappMedia.baixarEArmazenarMidia }) {
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
      await salvarConversa(pool, tenantId, telefoneE164, { estado: 'recebendo_arquivos', respostas: { tipoFluxo: 'com_arquivo', arquivos: [] } });
      return [envioTexto(MENSAGEM_PEDIR_ARQUIVOS)];
    }
    if (entrada.tipo === 'botao' && entrada.id === 'sem_arquivo') {
      await salvarConversa(pool, tenantId, telefoneE164, { estado: 'pergunta_referencia', respostas: { tipoFluxo: 'sem_arquivo' } });
      return [envioTexto(PERGUNTA_REFERENCIA)];
    }
    return [envioBotoes(PERGUNTA_ARQUIVO_TEXTO, PERGUNTA_ARQUIVO_BOTOES)];
  }

  if (conversa.estado === 'recebendo_arquivos') {
    const arquivosAtuais = conversa.respostas.arquivos || [];

    if (entrada.tipo === 'arquivo') {
      let baixado;
      try {
        baixado = await baixarMidia(entrada.mediaId, { nomeArquivoSugerido: entrada.nomeArquivo });
      } catch (erro) {
        console.error(`[bot-whatsapp] Falha ao baixar mídia ${entrada.mediaId}: ${erro.message}`);
        return [envioTexto(MENSAGEM_FALHA_BAIXAR_ARQUIVO)];
      }
      const respostas = { ...conversa.respostas, arquivos: [...arquivosAtuais, { ...baixado, mediaId: entrada.mediaId }] };
      await salvarConversa(pool, tenantId, telefoneE164, { estado: 'recebendo_arquivos', respostas });
      return [envioTexto(MENSAGEM_ARQUIVO_RECEBIDO_LOOP)];
    }

    if (entrada.tipo === 'texto' && entrada.texto.trim().toLowerCase() === 'pronto') {
      if (arquivosAtuais.length === 0) return [envioTexto(MENSAGEM_PRECISA_1_ARQUIVO)];
      await salvarConversa(pool, tenantId, telefoneE164, { estado: 'pergunta_cor', respostas: conversa.respostas });
      return [envioTexto(PERGUNTA_COR)];
    }

    return [envioTexto(MENSAGEM_ENTRADA_NAO_RECONHECIDA_ARQUIVO)];
  }

  if (conversa.estado === 'pergunta_cor') {
    const cor = entrada.tipo === 'texto' ? entrada.texto.trim() : '';
    const respostas = { ...conversa.respostas, cor };
    await salvarConversa(pool, tenantId, telefoneE164, { estado: 'pergunta_quantidade', respostas });
    return [envioTexto(PERGUNTA_QUANTIDADE)];
  }

  if (conversa.estado === 'pergunta_referencia') {
    const respostas = { ...conversa.respostas };
    if (entrada.tipo === 'arquivo') {
      let baixado;
      try {
        baixado = await baixarMidia(entrada.mediaId, { nomeArquivoSugerido: entrada.nomeArquivo });
      } catch (erro) {
        console.error(`[bot-whatsapp] Falha ao baixar mídia ${entrada.mediaId}: ${erro.message}`);
        return [envioTexto(MENSAGEM_FALHA_BAIXAR_ARQUIVO)];
      }
      respostas.arquivos = [{ ...baixado, mediaId: entrada.mediaId }];
      respostas.referenciaArquivo = baixado.nomeArquivo;
    } else {
      respostas.referenciaTexto = entrada.tipo === 'texto' ? entrada.texto.trim() : '';
    }
    await salvarConversa(pool, tenantId, telefoneE164, { estado: 'pergunta_quantidade', respostas });
    return [envioTexto(PERGUNTA_QUANTIDADE)];
  }

  if (conversa.estado === 'pergunta_quantidade') {
    const texto = entrada.tipo === 'texto' ? entrada.texto.trim() : '';
    if (!/^\d+$/.test(texto) || Number(texto) < 1) {
      return [envioTexto(MENSAGEM_QUANTIDADE_INVALIDA)];
    }
    const respostas = { ...conversa.respostas, quantidade: Number(texto) };
    return avancarParaEnderecoOuFinalizar(pool, tenantId, telefoneE164, nomeWhatsapp, respostas);
  }

  if (conversa.estado === 'pergunta_cep') {
    const cep = entrada.tipo === 'texto' ? entrada.texto.trim() : '';
    const respostas = { ...conversa.respostas, cep };
    await salvarConversa(pool, tenantId, telefoneE164, { estado: 'pergunta_numero', respostas });
    return [envioTexto(PERGUNTA_NUMERO)];
  }

  if (conversa.estado === 'pergunta_numero') {
    const numero = entrada.tipo === 'texto' ? entrada.texto.trim() : '';
    const respostas = { ...conversa.respostas, numero };
    await salvarConversa(pool, tenantId, telefoneE164, { estado: 'pergunta_complemento', respostas });
    return [envioTexto(PERGUNTA_COMPLEMENTO)];
  }

  if (conversa.estado === 'pergunta_complemento') {
    const textoRecebido = entrada.tipo === 'texto' ? entrada.texto.trim() : '';
    const semComplemento = RESPOSTAS_SEM_COMPLEMENTO.includes(textoRecebido.toLowerCase());
    const respostas = { ...conversa.respostas, complemento: semComplemento ? null : textoRecebido };

    await encerrarConversa(pool, tenantId, telefoneE164);
    try {
      await finalizarPedido(pool, tenantId, telefoneE164, nomeWhatsapp, respostas);
    } catch (erro) {
      console.error(`[bot-whatsapp] Falha ao criar pedido pra ${telefoneE164} (tenant ${tenantId}): ${erro.message}`);
    }
    return [envioTexto(mensagemConfirmacao(respostas))];
  }

  // Estado desconhecido (dado corrompido/versão antiga) — reinicia do zero
  // em vez de travar a conversa pro cliente pra sempre.
  await encerrarConversa(pool, tenantId, telefoneE164);
  return [];
}

module.exports = { processarMensagem, SAUDACAO_TEXTO, SAUDACAO_BOTOES };
