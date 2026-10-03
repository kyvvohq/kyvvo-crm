// Bot conversacional de atendimento por WhatsApp — primeiro caso: Basic 3D
// Print (briefing do Bruno, revisado ao longo de 2026-09-24: botões/lista
// nativos, saudação personalizada, coleta de arquivo(s)/referência,
// quantidade validada e endereço de entrega numa única mensagem). Fluxo
// fixo e sequencial (sem IA, sem n8n — diferente do bot do Studio). Estado
// da conversa persistido em crm_conversas_whatsapp — cada mensagem
// recebida avança um passo.
const { encontrarOuCriarPorTelefone } = require('./clientes');
const { proximoNumeroPedido } = require('./pedidos');
const whatsappMedia = require('./whatsapp-media');
const { dispararNotificacaoEvento } = require('./notificacoes');

function envioTexto(texto) {
  return { tipo: 'texto', texto };
}
function envioBotoes(texto, botoes) {
  return { tipo: 'botoes', texto, botoes };
}
function envioLista(texto, tituloBotao, opcoes) {
  return { tipo: 'lista', texto, tituloBotao, opcoes };
}

function saudacaoTexto(nomeWhatsapp) {
  const primeiroNome = nomeWhatsapp ? String(nomeWhatsapp).trim().split(/\s+/)[0] : null;
  const abertura = primeiroNome ? `Olá, ${primeiroNome}! 👋` : 'Olá! 👋';
  return `${abertura} Seja bem-vindo(a) à *Basic 3D Print*! 💙\n\n`
    + 'Trabalhamos com *impressões 3D personalizadas* e produtos à pronta entrega.\n\n'
    + 'Como podemos te ajudar?';
}
const SAUDACAO_BOTOES = [
  { id: 'fazer_pedido', titulo: 'Fazer pedido' },
  { id: 'ver_lojas', titulo: 'Ver lojas' },
  { id: 'falar_atendente', titulo: 'Falar com atendente' },
];

// Horário de atendimento humano (Configurações > Geral, pedido do Bruno
// 2026-10-03 — era fixo 8h-18h, agora configurável por tenant). Dias úteis
// continuam fixos (Seg-Sex) — só o horário em si foi pedido como
// configurável. Calcula em America/Sao_Paulo (não no fuso do servidor, que
// no EC2 é UTC) via Intl, sem dependência nova.
function estaDentroDoHorarioComercial(data = new Date(), { inicio = 8, fim = 18 } = {}) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    hour: 'numeric',
    hour12: false,
    weekday: 'short',
  }).formatToParts(data);
  const hora = Number(partes.find((p) => p.type === 'hour').value);
  const diaSemana = partes.find((p) => p.type === 'weekday').value;
  const diasUteis = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  return diasUteis.includes(diaSemana) && hora >= inicio && hora < fim;
}

const MENSAGEM_CHAMANDO_ATENDENTE = 'Claro! 😊 Já avisei nossa equipe — em breve alguém vai continuar seu atendimento por aqui mesmo.';
function mensagemForaDoHorarioAtendente(inicio, fim) {
  return `No momento não temos atendimento humano — nosso horário é *Seg. a Sex., das ${inicio}h às ${fim}h*.\n\n`
    + 'Por favor, entre em contato novamente dentro desse período que alguém da nossa equipe vai te atender. 😊';
}

// Best-effort (mesmo princípio do resto do arquivo): se a consulta falhar
// por qualquer motivo, cai no horário padrão em vez de travar o bot.
async function buscarHorarioAtendimento(pool, tenantId) {
  try {
    const { rows } = await pool.query(
      'select horario_atendimento_inicio, horario_atendimento_fim from crm_configuracoes where tenant_id = $1',
      [tenantId]
    );
    return {
      inicio: (rows[0] && rows[0].horario_atendimento_inicio) ?? 8,
      fim: (rows[0] && rows[0].horario_atendimento_fim) ?? 18,
    };
  } catch {
    return { inicio: 8, fim: 18 };
  }
}

// Transferência pra humano (pedido do Bruno, 2026-10-02): "falar com
// atendente" é um botão explícito, não uma palavra-chave reconhecida em
// texto livre — evitar falso positivo (ex.: cliente digitando "pessoa" ou
// "humano" no meio da descrição de uma peça personalizada nos fluxos de
// texto livre). Só avisa a equipe (notificação) — não existe hoje um modo
// de "bot silencioso, operador assume" nesta máquina de estado.
async function tratarPedidoDeAtendente(pool, tenantId, telefoneE164, agora) {
  const { inicio, fim } = await buscarHorarioAtendimento(pool, tenantId);
  if (!estaDentroDoHorarioComercial(agora(), { inicio, fim })) {
    dispararNotificacaoEvento(pool, tenantId, 'contato_fora_horario', {
      titulo: 'Cliente tentou falar com atendente fora do horário comercial',
      detalhe: `WhatsApp ${telefoneE164} pediu atendimento humano fora do horário (Seg-Sex ${inicio}h-${fim}h).`,
    }).catch(() => {});
    return [envioTexto(mensagemForaDoHorarioAtendente(inicio, fim))];
  }
  dispararNotificacaoEvento(pool, tenantId, 'cliente_quer_atendente', {
    titulo: 'Cliente pediu para falar com atendente',
    detalhe: `WhatsApp ${telefoneE164} pediu para falar com um atendente.`,
  }).catch(() => {});
  return [envioTexto(MENSAGEM_CHAMANDO_ATENDENTE)];
}

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
const POS_LOJAS_BOTOES = [
  { id: 'encerrar_atendimento', titulo: 'Encerrar atendimento' },
  { id: 'voltar_menu', titulo: 'Voltar ao menu' },
  { id: 'falar_atendente', titulo: 'Falar com atendente' },
];
const MENSAGEM_DESPEDIDA = 'Obrigado, qualquer dúvida é só chamar! Até mais.';

const MENSAGEM_PEDIR_ARQUIVOS = 'Show! 📎 Pode mandar o(s) arquivo(s) aqui mesmo pelo WhatsApp (STL, OBJ, foto, PDF etc).\n\n'
  + 'Quando terminar de enviar, digite *pronto*.';
const MENSAGEM_ARQUIVO_RECEBIDO_LOOP = 'Arquivo recebido! ✅ Pode mandar mais um, ou digite *pronto* quando terminar.';
const MENSAGEM_PRECISA_1_ARQUIVO = 'Preciso de pelo menos 1 arquivo — manda o arquivo, por favor, ou digite *pronto* depois de enviar.';
const MENSAGEM_ENTRADA_NAO_RECONHECIDA_ARQUIVO = 'Não recebi nenhum arquivo aí 🤔 Pode mandar o arquivo, ou digitar *pronto* se já terminou de enviar.';
const MENSAGEM_FALHA_BAIXAR_ARQUIVO = 'Ih, não consegui baixar esse arquivo agora 😕 Pode tentar mandar de novo?';

const PERGUNTA_COR = 'Qual *cor* você prefere?';
const PERGUNTA_QUANTIDADE = 'Quantas *peças* você quer?';
const MENSAGEM_QUANTIDADE_INVALIDA = 'A quantidade precisa ser um número inteiro de pelo menos 1. Quantas peças você quer?';

const PERGUNTA_ENDERECO = '📍 Pra gente calcular a entrega, me envie seu endereço completo em uma única mensagem.\n\n'
  + 'Exemplo:\nRua das Flores, 123, Apto 202, Centro, Uberlândia - MG, 38400-000';

// --- Fluxo "não tenho arquivo" -------------------------------------------
const TIPOS_PECA_LISTA = [
  { id: 'biscoito', titulo: 'Cortador de biscoito' },
  { id: 'projeto_3d', titulo: 'Projeto 3D' },
  { id: 'brinde', titulo: 'Brinde' },
  { id: 'decoracao', titulo: 'Decoração' },
  { id: 'outro', titulo: 'Outro' },
];
const TIPOS_PECA_TITULO = Object.fromEntries(TIPOS_PECA_LISTA.map((o) => [o.id, o.titulo]));
const PERGUNTA_TIPO_PECA_TEXTO = 'Qual é o tipo da peça?';
const PERGUNTA_TIPO_PECA_BOTAO = 'Escolher';
const PERGUNTA_TIPO_PECA_OUTRO = 'Me descreva brevemente sobre essa peça:';

const MENSAGEM_AVISO_TEXTAO_A = '😅 Agora vem um textinho maior… mas não se assuste!\n\n'
  + 'Essas informações são importantes para entendermos exatamente o que você precisa e garantir que a sua peça fique do jeito que você espera. 🎯\n\n'
  + 'Pode responder com calma. Quanto mais detalhes você conseguir nos passar, melhor conseguiremos entender o seu projeto e mais rápido poderemos produzir a sua peça. 🚀\n\n'
  + 'Vamos lá? 👇';

const MENSAGEM_DETALHES_B = '😅 Agora vem um textinho maior… mas é por uma boa causa!\n\n'
  + 'Como cada peça pode ter características diferentes, precisamos entender alguns detalhes antes de produzir. Essas informações ajudam nossa equipe a entender exatamente o que você precisa, evitar retrabalho e entregar um resultado mais próximo do que você imaginou. 🎯\n\n'
  + 'Pode responder com calma. Se alguma pergunta não fizer sentido para o seu projeto, é só informar *não se aplica*.\n\n'
  + '*Sobre a sua peça:*\n\n'
  + '🔹 *É uma peça personalizada com logo, nome ou marca?*\nSe sim, envie o logo, imagem ou arquivo que deseja utilizar.\n\n'
  + '🔹 *Possui algum tema, personagem, formato ou estilo específico?*\nConte um pouco sobre como você gostaria que fosse.\n\n'
  + '🔹 *Qual tamanho aproximado você deseja?*\nEx.: 5 cm, 10 cm, 20 cm etc.\n\n'
  + '🔹 *Existe alguma característica específica que devemos considerar?*\nPor exemplo: formato, espessura, acabamento, detalhes, encaixes, bordinhas ou qualquer outra preferência.\n\n'
  + '💡 *Quanto mais informações você nos passar, melhor conseguiremos entender sua ideia e mais rápido poderemos produzir sua peça.*\n\n'
  + 'Depois, vamos pedir uma referência e a quantidade desejada para finalizar seu pedido. 😊';

const MENSAGEM_QUASE_LA_C = '😊 Estamos quase lá!\n\n'
  + 'Só precisamos de mais algumas informações para conseguir seguir com o seu pedido:\n\n'
  + '📸 Tem alguma foto, desenho ou referência da peça?\nPode enviar aqui mesmo. Qualquer referência ajuda a gente a entender melhor o que você imaginou.';

const MENSAGEM_PRONTO_F = '✨ Pronto! Com essas informações, teremos tudo o que precisamos para entender seu pedido e dar andamento à produção.';

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

async function clienteTemEnderecoCompleto(pool, tenantId, telefoneE164) {
  const { rows } = await pool.query('select endereco_completo from crm_clientes where tenant_id = $1 and telefone = $2', [tenantId, telefoneE164]);
  return !!(rows[0] && rows[0].endereco_completo);
}

function mensagemConfirmacao(respostas) {
  if (respostas.tipoFluxo === 'com_arquivo') {
    const linhas = [
      `🔹 Arquivo(s): ${respostas.arquivos.map((a) => a.nomeArquivo).join(', ')}`,
      `🔹 Cor: ${respostas.cor}`,
      `🔹 Quantidade: ${respostas.quantidade}`,
      `🔹 Entrega: ${respostas.enderecoCompleto}`,
    ];
    return `Perfeito! Anotei tudo aqui:\n\n${linhas.join('\n')}\n\n`
      + 'Já registrei seu pedido por aqui e nossa equipe vai te chamar em breve pra confirmar valor e prazo. Obrigado por escolher a Basic 3D Print! 🙌';
  }

  const linhas = [
    `🔹 Tipo de peça: ${respostas.tipoPeca || respostas.tipoPecaDescricao}`,
    `🔹 Detalhes: ${respostas.descricaoCompleta || '—'}`,
    `🔹 Referência: ${respostas.referenciaTexto || respostas.referenciaArquivo || '—'}`,
    `🔹 Quantidade: ${respostas.quantidade}`,
    `🔹 Entrega: ${respostas.enderecoCompleto}`,
  ];
  return `${MENSAGEM_PRONTO_F}\n\n${linhas.join('\n')}\n\n`
    + 'Já registrei seu pedido por aqui e nossa equipe vai te chamar em breve pra confirmar valor e prazo. Obrigado por escolher a Basic 3D Print! 🙌';
}

// Acha-ou-cria o cliente (nome do WhatsApp quando é cadastro novo — nunca
// sobrescreve nome de cliente já existente), atualiza endereço se coletado
// nesta conversa, cria o pedido (com itens/arquivos conforme o fluxo).
// Best-effort: se a conta não tiver etapa fixa "A fazer" configurada (não
// devia acontecer, inicializarEtapasPadrao/migration 013 já cobrem isso),
// loga e segue sem travar a confirmação pro cliente.
async function finalizarPedido(pool, tenantId, telefoneE164, nomeWhatsapp, respostas) {
  const { rows: etapaRows } = await pool.query(
    `select id from crm_etapas where tenant_id = $1 and fixa = true limit 1`,
    [tenantId]
  );
  if (!etapaRows[0]) {
    console.error(`[bot-whatsapp] tenant ${tenantId} sem etapa fixa ("A fazer") — pedido do bot não foi criado (cliente ainda foi cadastrado).`);
    return null;
  }

  const cliente = await encontrarOuCriarPorTelefone(pool, tenantId, { telefone: telefoneE164, nome: nomeWhatsapp, origem: 'WhatsApp' });

  if (respostas.enderecoCompleto) {
    await pool.query('update crm_clientes set endereco_completo = $1, atualizado_em = now() where id = $2', [respostas.enderecoCompleto, cliente.id]);
  }

  const descricao = respostas.tipoFluxo === 'com_arquivo'
    ? `Arquivo(s): ${respostas.arquivos.map((a) => a.nomeArquivo).join(', ')} — cor ${respostas.cor}`
    : `Tipo: ${respostas.tipoPeca || respostas.tipoPecaDescricao} — ${respostas.descricaoCompleta || 'sem detalhes adicionais'} — referência: ${respostas.referenciaTexto || respostas.referenciaArquivo || 'nenhuma'}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const numero = await proximoNumeroPedido(client, tenantId);
    const { rows: pedidoRows } = await client.query(
      `insert into crm_pedidos (tenant_id, cliente_id, etapa_id, origem, numero) values ($1, $2, $3, 'WhatsApp', $4) returning *`,
      [tenantId, cliente.id, etapaRows[0].id, numero]
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

// Depois da quantidade validada (comum aos dois fluxos): pula pra
// finalizar se o cliente já tem endereço, senão pergunta o endereço
// completo (uma mensagem só).
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
  await salvarConversa(pool, tenantId, telefoneE164, { estado: 'pergunta_endereco', respostas });
  return [envioTexto(PERGUNTA_ENDERECO)];
}

async function finalizarComEndereco(pool, tenantId, telefoneE164, nomeWhatsapp, respostas) {
  await encerrarConversa(pool, tenantId, telefoneE164);
  try {
    await finalizarPedido(pool, tenantId, telefoneE164, nomeWhatsapp, respostas);
  } catch (erro) {
    console.error(`[bot-whatsapp] Falha ao criar pedido pra ${telefoneE164} (tenant ${tenantId}): ${erro.message}`);
  }
  return [envioTexto(mensagemConfirmacao(respostas))];
}

// Processa 1 mensagem recebida (texto, clique de botão/lista ou arquivo) e
// devolve a(s) mensagem(ns) a enviar de volta (cada uma já no formato
// {tipo:'texto'|'botoes'|'lista', ...}) — não manda nada sozinho, só decide
// o conteúdo e persiste o avanço de estado.
//
// `entrada`: { tipo: 'texto', texto } | { tipo: 'botao', id } | { tipo: 'arquivo', mediaId, nomeArquivo }
//   (cliques de lista chegam normalizados como 'botao' — ver index.js)
// `nomeWhatsapp`: nome do perfil do contato no WhatsApp (Meta manda em
// quase toda mensagem) — usado na saudação e, se o cliente ainda não tiver
// cadastro, no nome do cliente criado.
async function processarMensagem(pool, { tenantId, telefoneE164, entrada, nomeWhatsapp, baixarMidia = whatsappMedia.baixarEArmazenarMidia, agora = () => new Date() }) {
  const conversa = await buscarConversa(pool, tenantId, telefoneE164);

  if (!conversa) {
    await salvarConversa(pool, tenantId, telefoneE164, { estado: 'aguardando_opcao', respostas: {} });
    return [envioBotoes(saudacaoTexto(nomeWhatsapp), SAUDACAO_BOTOES)];
  }

  if (conversa.estado === 'aguardando_opcao') {
    if (entrada.tipo === 'botao' && entrada.id === 'fazer_pedido') {
      await salvarConversa(pool, tenantId, telefoneE164, { estado: 'aguardando_arquivo', respostas: {} });
      return [envioBotoes(PERGUNTA_ARQUIVO_TEXTO, PERGUNTA_ARQUIVO_BOTOES)];
    }
    if (entrada.tipo === 'botao' && entrada.id === 'ver_lojas') {
      await salvarConversa(pool, tenantId, telefoneE164, { estado: 'pos_lojas', respostas: {} });
      return [envioBotoes(MENSAGEM_LOJAS, POS_LOJAS_BOTOES)];
    }
    if (entrada.tipo === 'botao' && entrada.id === 'falar_atendente') {
      return tratarPedidoDeAtendente(pool, tenantId, telefoneE164, agora);
    }
    return [envioBotoes(saudacaoTexto(nomeWhatsapp), SAUDACAO_BOTOES)];
  }

  if (conversa.estado === 'pos_lojas') {
    if (entrada.tipo === 'botao' && entrada.id === 'encerrar_atendimento') {
      await encerrarConversa(pool, tenantId, telefoneE164);
      return [envioTexto(MENSAGEM_DESPEDIDA)];
    }
    if (entrada.tipo === 'botao' && entrada.id === 'voltar_menu') {
      await salvarConversa(pool, tenantId, telefoneE164, { estado: 'aguardando_opcao', respostas: {} });
      return [envioBotoes(saudacaoTexto(nomeWhatsapp), SAUDACAO_BOTOES)];
    }
    if (entrada.tipo === 'botao' && entrada.id === 'falar_atendente') {
      return tratarPedidoDeAtendente(pool, tenantId, telefoneE164, agora);
    }
    return [envioBotoes(MENSAGEM_LOJAS, POS_LOJAS_BOTOES)];
  }

  if (conversa.estado === 'aguardando_arquivo') {
    if (entrada.tipo === 'botao' && entrada.id === 'tem_arquivo') {
      await salvarConversa(pool, tenantId, telefoneE164, { estado: 'recebendo_arquivos', respostas: { tipoFluxo: 'com_arquivo', arquivos: [] } });
      return [envioTexto(MENSAGEM_PEDIR_ARQUIVOS)];
    }
    if (entrada.tipo === 'botao' && entrada.id === 'sem_arquivo') {
      await salvarConversa(pool, tenantId, telefoneE164, { estado: 'pergunta_tipo_peca', respostas: { tipoFluxo: 'sem_arquivo' } });
      return [envioLista(PERGUNTA_TIPO_PECA_TEXTO, PERGUNTA_TIPO_PECA_BOTAO, TIPOS_PECA_LISTA)];
    }
    return [envioBotoes(PERGUNTA_ARQUIVO_TEXTO, PERGUNTA_ARQUIVO_BOTOES)];
  }

  // --- Fluxo "tenho arquivo" ----------------------------------------------
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

  // --- Fluxo "não tenho arquivo" -------------------------------------------
  if (conversa.estado === 'pergunta_tipo_peca') {
    if (entrada.tipo === 'botao' && entrada.id === 'outro') {
      await salvarConversa(pool, tenantId, telefoneE164, { estado: 'pergunta_tipo_peca_outro', respostas: conversa.respostas });
      return [envioTexto(PERGUNTA_TIPO_PECA_OUTRO)];
    }
    if (entrada.tipo === 'botao' && TIPOS_PECA_TITULO[entrada.id]) {
      const respostas = { ...conversa.respostas, tipoPeca: TIPOS_PECA_TITULO[entrada.id] };
      await salvarConversa(pool, tenantId, telefoneE164, { estado: 'pergunta_detalhes', respostas });
      return [envioTexto(MENSAGEM_AVISO_TEXTAO_A), envioTexto(MENSAGEM_DETALHES_B)];
    }
    return [envioLista(PERGUNTA_TIPO_PECA_TEXTO, PERGUNTA_TIPO_PECA_BOTAO, TIPOS_PECA_LISTA)];
  }

  if (conversa.estado === 'pergunta_tipo_peca_outro') {
    const tipoPecaDescricao = entrada.tipo === 'texto' ? entrada.texto.trim() : '';
    const respostas = { ...conversa.respostas, tipoPecaDescricao };
    await salvarConversa(pool, tenantId, telefoneE164, { estado: 'pergunta_detalhes', respostas });
    return [envioTexto(MENSAGEM_AVISO_TEXTAO_A), envioTexto(MENSAGEM_DETALHES_B)];
  }

  if (conversa.estado === 'pergunta_detalhes') {
    const respostas = { ...conversa.respostas };
    if (entrada.tipo === 'arquivo') {
      let baixado;
      try {
        baixado = await baixarMidia(entrada.mediaId, { nomeArquivoSugerido: entrada.nomeArquivo });
      } catch (erro) {
        console.error(`[bot-whatsapp] Falha ao baixar mídia ${entrada.mediaId}: ${erro.message}`);
        return [envioTexto(MENSAGEM_FALHA_BAIXAR_ARQUIVO)];
      }
      respostas.arquivos = [...(respostas.arquivos || []), { ...baixado, mediaId: entrada.mediaId }];
    } else {
      respostas.descricaoCompleta = entrada.tipo === 'texto' ? entrada.texto.trim() : '';
    }
    await salvarConversa(pool, tenantId, telefoneE164, { estado: 'pergunta_referencia_sem_arquivo', respostas });
    return [envioTexto(MENSAGEM_QUASE_LA_C)];
  }

  if (conversa.estado === 'pergunta_referencia_sem_arquivo') {
    const respostas = { ...conversa.respostas };
    if (entrada.tipo === 'arquivo') {
      let baixado;
      try {
        baixado = await baixarMidia(entrada.mediaId, { nomeArquivoSugerido: entrada.nomeArquivo });
      } catch (erro) {
        console.error(`[bot-whatsapp] Falha ao baixar mídia ${entrada.mediaId}: ${erro.message}`);
        return [envioTexto(MENSAGEM_FALHA_BAIXAR_ARQUIVO)];
      }
      respostas.arquivos = [...(respostas.arquivos || []), { ...baixado, mediaId: entrada.mediaId }];
      respostas.referenciaArquivo = baixado.nomeArquivo;
    } else {
      respostas.referenciaTexto = entrada.tipo === 'texto' ? entrada.texto.trim() : '';
    }
    await salvarConversa(pool, tenantId, telefoneE164, { estado: 'pergunta_quantidade', respostas });
    return [envioTexto(PERGUNTA_QUANTIDADE)];
  }

  // --- Compartilhado pelos dois fluxos --------------------------------------
  if (conversa.estado === 'pergunta_quantidade') {
    const texto = entrada.tipo === 'texto' ? entrada.texto.trim() : '';
    if (!/^\d+$/.test(texto) || Number(texto) < 1) {
      return [envioTexto(MENSAGEM_QUANTIDADE_INVALIDA)];
    }
    const respostas = { ...conversa.respostas, quantidade: Number(texto) };
    return avancarParaEnderecoOuFinalizar(pool, tenantId, telefoneE164, nomeWhatsapp, respostas);
  }

  if (conversa.estado === 'pergunta_endereco') {
    const enderecoCompleto = entrada.tipo === 'texto' ? entrada.texto.trim() : '';
    const respostas = { ...conversa.respostas, enderecoCompleto };
    return finalizarComEndereco(pool, tenantId, telefoneE164, nomeWhatsapp, respostas);
  }

  // Estado desconhecido (dado corrompido/versão antiga) — reinicia do zero
  // em vez de travar a conversa pro cliente pra sempre. Bug real encontrado
  // em produção (2026-09-28): antes só reiniciava e devolvia [] — o cliente
  // mandava mensagem, a conversa era limpa silenciosamente, e ele nunca
  // recebia nada de volta (parecia bot fora do ar). Mesmo princípio já usado
  // no resto do fluxo: nunca deixar uma mensagem sem resposta.
  //
  // Único ponto do bot que já representava "o cliente pode estar travado"
  // (ver notificacoes.js#atendimento_bot_travado) — por isso a notificação
  // avisa a equipe aqui, não em cada "entrada não reconhecida" de dentro de
  // um fluxo normal (isso é esperado, o bot já reage pedindo de novo).
  dispararNotificacaoEvento(pool, tenantId, 'atendimento_bot_travado', {
    titulo: 'Cliente pode estar com dificuldade no atendimento automático',
    detalhe: `WhatsApp ${telefoneE164} — a conversa foi reiniciada por estado inválido.`,
  }).catch(() => {});
  await salvarConversa(pool, tenantId, telefoneE164, { estado: 'aguardando_opcao', respostas: {} });
  return [envioBotoes(saudacaoTexto(nomeWhatsapp), SAUDACAO_BOTOES)];
}

// "Retomada" de conversa parada (Configurações > Geral, pedido do Bruno
// 2026-10-03): se o cliente não avança a conversa há mais tempo que
// bot_retomada_horas (por tenant, padrão 24h quando a conta ainda não
// configurou nada — mesmo default do GET /crm/api/configuracoes-gerais),
// apaga o estado salvo — a próxima mensagem dele começa do zero (saudação),
// em vez de ser tratada como resposta a uma pergunta de muito tempo atrás.
// Chamado pelo checador periódico de index.js (setInterval, a cada hora).
async function checarConversasParaRetomar(pool) {
  const { rows } = await pool.query(
    `select c.tenant_id, c.telefone_e164
     from crm_conversas_whatsapp c
     left join crm_configuracoes cfg on cfg.tenant_id = c.tenant_id
     where c.atualizado_em < now() - (coalesce(cfg.bot_retomada_horas, 24) || ' hours')::interval`
  );
  for (const { tenant_id: tenantId, telefone_e164: telefoneE164 } of rows) {
    // eslint-disable-next-line no-await-in-loop
    await encerrarConversa(pool, tenantId, telefoneE164);
  }
}

// --- Histórico de mensagens (crm_mensagens_whatsapp, migration 014) --------
// Log append-only, separado do estado da conversa (crm_conversas_whatsapp,
// que continua existindo e sendo sobrescrito a cada passo — isto aqui é só
// pra tela de Conversas mostrar o histórico de verdade). Best-effort: nunca
// lança — uma falha de log não pode derrubar o webhook nem a resposta ao
// cliente (mesmo princípio já usado no resto do produto).
async function registrarMensagem(pool, { tenantId, telefoneE164, direcao, tipo, conteudo }) {
  try {
    await pool.query(
      `insert into crm_mensagens_whatsapp (tenant_id, telefone_e164, direcao, tipo, conteudo) values ($1, $2, $3, $4, $5)`,
      [tenantId, telefoneE164, direcao, tipo, conteudo]
    );
  } catch (erro) {
    console.error(`[bot-whatsapp] Falha ao registrar mensagem (${direcao}): ${erro.message}`);
  }
}

// Texto pra guardar no histórico a partir do que o webhook recebeu da Meta
// (extrairEntradaBot, index.js) — mesmas 3 formas que o bot entende.
function textoDaEntrada(entrada) {
  if (entrada.tipo === 'texto') return entrada.texto;
  if (entrada.tipo === 'botao') return `[clicou: ${entrada.id}]`;
  if (entrada.tipo === 'arquivo') return `[arquivo enviado: ${entrada.nomeArquivo || entrada.mediaId}]`;
  return '[mensagem não suportada]';
}

// Texto pra guardar no histórico a partir de um envio do bot (envioTexto/
// envioBotoes/envioLista acima) — junta o texto com os rótulos dos botões/
// opções, já que o histórico grava só texto, não a interação nativa.
function textoDoEnvio(envio) {
  if (envio.tipo === 'botoes') return `${envio.texto}\n[${envio.botoes.map((b) => b.titulo).join(' | ')}]`;
  if (envio.tipo === 'lista') return `${envio.texto}\n[${envio.opcoes.map((o) => o.titulo).join(' | ')}]`;
  return envio.texto;
}

module.exports = {
  processarMensagem, saudacaoTexto, SAUDACAO_BOTOES, registrarMensagem, textoDaEntrada, textoDoEnvio,
  estaDentroDoHorarioComercial, checarConversasParaRetomar,
};
