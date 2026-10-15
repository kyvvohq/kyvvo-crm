const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { filtrarResposta, higienizarEntrada } = require('../lib/agente/posfiltro');
const { dentroDoHorario } = require('../lib/agente/horario');

const temBanco = !!process.env.DATABASE_URL;
const opts = temBanco ? {} : { skip: 'sem DATABASE_URL' };
const { pool, migrar } = require('../lib/db');
const { semearAgente } = require('../lib/agente/seed');
const { executarTurno: executarTurnoReal } = require('../lib/agente/executor');
// Relógio fixo dentro do horário de atendimento: os testes não dependem da hora em que rodam.
const DENTRO = new Date('2026-10-12T15:00:00Z');
const executarTurno = (turno, deps = {}) => executarTurnoReal(turno, { agora: () => DENTRO, ...deps });
const { executarFerramenta, FERRAMENTAS } = require('../lib/agente/ferramentas');
const { processarConversa } = require('../lib/agente/processador');

const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'db', 'seeds', 'basic.json'), 'utf8'));
const FRASE_VIP = seed.config.textos.desconto_vip;
const ENCAMINHAMENTO = seed.config.textos.encaminhamento;
const A = crypto.randomUUID();
const B = crypto.randomUUID();
let seq = 0;

// --- cliente do modelo falso: roteiro de respostas, guarda cada chamada ---
const toolUse = (name, input, id = `tu_${++seq}`) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 100, output_tokens: 20 } });
const falou = (t) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }], usage: { input_tokens: 120, output_tokens: 30 } });
function iaFalsa(respostas) {
  const chamadas = [];
  return {
    chamadas,
    criarMensagem: async (params) => {
      chamadas.push(JSON.parse(JSON.stringify(params)));
      const r = respostas[chamadas.length - 1];
      if (!r) throw new Error('roteiro do modelo acabou');
      return r;
    },
  };
}

async function novaConversa(tenant, mensagens, { situacao = 'bot', janelaHoras = 24, nome = 'Maria Silva' } = {}) {
  const fone = `+5534977${String(++seq).padStart(6, '0')}`;
  const { rows: [conversa] } = await pool.query(
    `insert into crm_conversas_whatsapp (tenant_id, telefone_e164, estado, situacao, ultima_msg_cliente_em, janela_expira_em, nome_whatsapp)
     values ($1, $2, 'agente', $3, now(), now() + make_interval(hours => $4), $5) returning *`, [tenant, fone, situacao, janelaHoras, nome]);
  const ms = [];
  for (const m of mensagens) {
    const { rows: [msg] } = await pool.query(
      `insert into crm_mensagens_whatsapp (tenant_id, telefone_e164, direcao, tipo, conteudo, wamid, autor, anexo_id)
       values ($1, $2, 'recebida', $3, $4, $5, 'cliente', $6) returning *`,
      [tenant, fone, m.tipo || 'texto', m.texto, `wamid.${crypto.randomUUID()}`, m.anexoId || null]);
    ms.push(msg);
  }
  return { conversa, mensagens: ms };
}

async function rodar(tenant, mensagens, respostas, extra = {}, deps = {}) {
  const ia = iaFalsa(respostas);
  const envios = [];
  const c = await novaConversa(tenant, mensagens, extra);
  const r = await executarTurno({ pool, tenantId: tenant, conversa: c.conversa, mensagens: c.mensagens }, {
    ia, enviarTexto: async (p) => { envios.push(p); return true; }, log: () => {}, ...deps,
  });
  return { ...c, ia, envios, r };
}

const handoffs = async (tenant, conversaId) => (await pool.query('select * from crm_handoffs where tenant_id = $1 and conversa_id = $2', [tenant, conversaId])).rows;

before(async () => {
  if (!temBanco) return;
  await migrar();
  for (const t of [A, B]) {
    await semearAgente(pool, t, seed, { modo: 'rascunho', conhecimento: { sistema: 'SISTEMA TESTE', voz: 'VOZ TESTE' } });
    await pool.query("insert into crm_etapas (tenant_id, nome, ordem, tipo, fixa) values ($1, 'A fazer', 1, 'aberta', true)", [t]);
  }
});

after(async () => {
  if (!temBanco) return;
  for (const t of [A, B]) {
    await pool.query('delete from crm_clientes_tags where cliente_id in (select id from crm_clientes where tenant_id = $1)', [t]);
    for (const tab of ['crm_handoffs', 'crm_agente_execucoes', 'crm_eventos', 'crm_anexos', 'crm_pedidos', 'crm_tags', 'crm_mensagens_whatsapp',
      'crm_conversas_whatsapp', 'crm_clientes', 'crm_etapas', 'crm_agente_conhecimento', 'crm_agente_config', 'crm_campos_customizados']) {
      await pool.query(`delete from ${tab} where tenant_id = $1`, [t]);
    }
  }
  await pool.end();
});

// ---------------------------------------------------------------- pós-filtro
test('pós-filtro: bloqueia valor, prazo, frete, pagamento, estoque e desconto', () => {
  const ruins = [
    'Fica R$ 50,00 cada', 'custa 50 reais', 'Sai por 12,90', 'Entrego em 3 dias úteis', 'Pronto amanhã!', 'Até dia 20 fica pronto',
    'Em 2 dias você recebe', 'O frete fica barato', 'Pagamento confirmado!', 'Já está pago', 'Mande o Pix', 'Metade de entrada', 'Temos em estoque',
    'Esse modelo está disponível', 'Não localizei esse modelo', 'Te dou 10% de desconto', 'Tem cupom', 'Pronta entrega',
  ];
  for (const t of ruins) assert.equal(filtrarResposta(t).ok, false, t);
});

test('pós-filtro: deixa passar conversa normal de briefing', () => {
  const boas = [
    'Oi! Sou a assistente virtual da Basic 3D Print. Como posso ajudar? 🩵', 'Qual a medida que você precisa? Algo como 2,5 cm?',
    'Vou passar para a equipe, que retorna com o orçamento certinho.', 'Me envia a logo em boa qualidade, por favor?',
    'Anotei 1 unidade do modelo. Está certo?', 'A equipe analisa a referência e apresenta uma proposta para você aprovar antes de produzir.',
  ];
  for (const t of boas) assert.equal(filtrarResposta(t).ok, true, t);
});

test('pós-filtro: frase VIP só passa com VIP confirmado e sem acréscimos', () => {
  assert.equal(filtrarResposta(FRASE_VIP, { fraseVip: FRASE_VIP, vipConfirmado: true }).ok, true);
  assert.equal(filtrarResposta(FRASE_VIP, { fraseVip: FRASE_VIP, vipConfirmado: false }).ok, false);
  assert.equal(filtrarResposta(`${FRASE_VIP} E mais 20% de desconto na entrega.`, { fraseVip: FRASE_VIP, vipConfirmado: true }).ok, false);
});

test('higienizarEntrada remove CPF e CNPJ', () => {
  assert.equal(higienizarEntrada('meu cpf 123.456.789-09 ok'), 'meu cpf [CPF removido] ok');
  assert.match(higienizarEntrada('12.345.678/0001-95'), /CNPJ removido/);
});

test('horário: dentro, fora, fuso de São Paulo e dias', () => {
  const h = { inicio: '08:00', fim: '18:00', fuso: 'America/Sao_Paulo', dias: null };
  assert.equal(dentroDoHorario(h, new Date('2026-10-12T15:00:00Z')), true); // 12:00 BRT, segunda
  assert.equal(dentroDoHorario(h, new Date('2026-10-12T22:00:00Z')), false); // 19:00 BRT
  assert.equal(dentroDoHorario(h, new Date('2026-10-12T10:00:00Z')), false); // 07:00 BRT
  assert.equal(dentroDoHorario({ ...h, dias: [1, 2, 3, 4, 5] }, new Date('2026-10-17T15:00:00Z')), false); // sábado
});

test('o agente não tem ferramenta de preço, frete, prazo, pagamento ou estoque', () => {
  for (const f of FERRAMENTAS) {
    assert.doesNotMatch(f.name, /preco|valor|frete|prazo|pagamento|estoque|catalogo/);
    assert.equal(f.input_schema.properties.tenant_id, undefined);
    assert.equal(f.input_schema.properties.cliente_id, undefined);
    assert.equal(f.input_schema.properties.pedido_id, undefined);
  }
});

// ------------------------------------------------------------------ executor
test('briefing: ferramenta grava rascunho, campos e item; modo rascunho não envia', opts, async () => {
  const x = await rodar(A, [{ texto: 'Oi! Quero um carimbo com a minha logo, 5 unidades, 6cm' }], [
    toolUse('buscar_ou_criar_cliente', { nome: 'Maria' }),
    toolUse('registrar_briefing', { produto_modelo: 'Carimbo com logo', categoria: 'Personalizado', quantidade: 5, medida: '6 cm', data_desejada: '2026-11-10', observacoes: 'logo vem em PNG' }),
    falou('Oi, Maria! Sou a assistente virtual da Basic 3D Print. Anotei tudo. Você tem a logo em boa qualidade?'),
  ]);
  assert.equal(x.envios.length, 0);
  assert.match(x.r.resposta, /assistente virtual/);
  assert.equal(x.r.bloqueada, false);
  const { rows: [p] } = await pool.query('select * from crm_pedidos where tenant_id = $1 and rascunho order by criado_em desc limit 1', [A]);
  assert.equal(p.origem, 'WhatsApp');
  assert.equal(p.observacoes, 'logo vem em PNG');
  const { rows: vals } = await pool.query('select c.chave, v.valor from crm_pedidos_valores v join crm_campos_customizados c on c.id = v.campo_id where v.pedido_id = $1', [p.id]);
  assert.deepEqual(Object.fromEntries(vals.map((v) => [v.chave, v.valor])), { produto_modelo: 'Carimbo com logo', categoria: 'Personalizado', medida: '6 cm', data_desejada: '2026-11-10' });
  const { rows: [it] } = await pool.query('select * from crm_pedidos_itens where pedido_id = $1', [p.id]);
  assert.equal(Number(it.quantidade), 5);
  const { rows: [e] } = await pool.query('select * from crm_agente_execucoes where id = $1', [x.r.execucaoId]);
  assert.equal(e.ferramentas_chamadas.length, 2);
  assert.equal(e.resposta_enviada, null);
  assert.equal(e.tokens_in, 100 + 100 + 120);
  // segundo briefing atualiza o mesmo rascunho (não cria outro)
  const y = await rodar(A, [{ texto: 'a data mudou' }], [toolUse('registrar_briefing', { medida: '8 cm' }), falou('Anotado!')]);
  assert.equal(y.r.bloqueada, false);
});

test('quantidade padrão por categoria é assumida e sinalizada para confirmar', opts, async () => {
  const x = await rodar(A, [{ texto: 'quero o cortador de coração' }], [
    toolUse('registrar_briefing', { produto_modelo: 'Cortador de coração', categoria: 'Cortador de biscoito' }),
    falou('Anotei 1 unidade do cortador. Está certo?'),
  ]);
  const resultado = x.ia.chamadas[1].messages.at(-1).content[0];
  assert.match(resultado.content, /quantidade_assumida/);
  const { rows } = await pool.query(
    `select i.quantidade from crm_pedidos_itens i join crm_pedidos p on p.id = i.pedido_id where p.tenant_id = $1 and i.descricao = 'Cortador de coração'`, [A]);
  assert.equal(Number(rows[0].quantidade), 1);
});

test('resposta com valor/prazo é trocada pelo encaminhamento, com handoff e motivo registrado', opts, async () => {
  const x = await rodar(A, [{ texto: 'quanto custa e em quanto tempo fica pronto?' }], [falou('Fica R$ 40,00 cada e pronto em 2 dias úteis!')]);
  assert.equal(x.r.bloqueada, true);
  assert.equal(x.r.resposta, ENCAMINHAMENTO);
  const { rows: [e] } = await pool.query('select * from crm_agente_execucoes where id = $1', [x.r.execucaoId]);
  assert.equal(e.bloqueada_por_filtro, true);
  assert.match(e.motivo_bloqueio, /valor_monetario/);
  assert.match(e.motivo_bloqueio, /prazo/);
  assert.equal(e.resposta_proposta, ENCAMINHAMENTO); // o texto original nunca vira proposta
  const h = await handoffs(A, x.conversa.id);
  assert.equal(h.length, 1);
  assert.equal(h[0].motivo, 'bloqueio_filtro');
  assert.equal(h[0].status, 'aberto');
  const { rows: [c] } = await pool.query('select situacao from crm_conversas_whatsapp where id = $1', [x.conversa.id]);
  assert.equal(c.situacao, 'aguardando_equipe');
});

test('desconto VIP: cliente com a tag recebe a frase; sem a tag, a mesma frase é bloqueada', opts, async () => {
  const vip = await rodar(A, [{ texto: 'faço parte do grupo VIP, tenho desconto?' }], [
    toolUse('consultar_cliente_vip', {}), // cria o cliente
    falou('x'), // não usado: refazemos abaixo com a tag já posta
  ]);
  // marca a cliente como VIP e roda de novo na mesma conversa
  const { rows: [tag] } = await pool.query("insert into crm_tags (tenant_id, nome) values ($1, 'VIP') returning id", [A]);
  await pool.query('insert into crm_clientes_tags (cliente_id, tag_id) values ($1, $2)', [(await pool.query('select cliente_id from crm_conversas_whatsapp where id = $1', [vip.conversa.id])).rows[0].cliente_id, tag.id]);
  const ia = iaFalsa([toolUse('consultar_cliente_vip', {}), falou(FRASE_VIP)]);
  const conv = (await pool.query('select * from crm_conversas_whatsapp where id = $1', [vip.conversa.id])).rows[0];
  const r1 = await executarTurno({ pool, tenantId: A, conversa: conv, mensagens: vip.mensagens }, { ia, enviarTexto: async () => true, log: () => {} });
  assert.equal(r1.bloqueada, false);
  assert.equal(r1.resposta, FRASE_VIP);
  assert.match(ia.chamadas[1].messages.at(-1).content[0].content, /"vip":true/);

  const naoVip = await rodar(A, [{ texto: 'sou VIP, quero meus 10%' }], [toolUse('consultar_cliente_vip', {}), falou(FRASE_VIP)]);
  assert.equal(naoVip.r.bloqueada, true);
  assert.equal(naoVip.r.resposta, ENCAMINHAMENTO);
  const h = await handoffs(A, naoVip.conversa.id);
  assert.equal(h[0].eh_vip, false);
});

test('transferir_para_equipe: um handoff aberto por conversa, atualizado a cada chamada', opts, async () => {
  const x = await rodar(A, [{ texto: 'meu pedido veio quebrado!' }], [
    toolUse('transferir_para_equipe', { motivo: 'produto_danificado_ou_diferente', resumo: 'Peça chegou quebrada' }),
    toolUse('transferir_para_equipe', { motivo: 'reclamacao', resumo: 'Cliente irritada, quer troca' }),
    falou('Sinto muito! A equipe vai continuar o seu atendimento por aqui. 🩵'),
  ]);
  const h = await handoffs(A, x.conversa.id);
  assert.equal(h.length, 1);
  assert.equal(h[0].motivo, 'reclamacao');
  assert.equal(h[0].resumo, 'Cliente irritada, quer troca');
});

test('motivo inválido do modelo vira "outro" e entrada extra é ignorada', opts, async () => {
  const x = await rodar(A, [{ texto: 'oi' }], [toolUse('transferir_para_equipe', { motivo: 'qualquer coisa', resumo: 'r', tenant_id: B }), falou('A equipe segue com você.')]);
  const h = await handoffs(A, x.conversa.id);
  assert.equal(h[0].motivo, 'outro');
  assert.equal(h[0].tenant_id, A);
  assert.equal((await handoffs(B, x.conversa.id)).length, 0);
});

test('isolamento: ferramenta com conversa de outro tenant falha e não grava nada', opts, async () => {
  const dela = await novaConversa(A, [{ texto: 'oi' }]);
  const ctxB = { tenantId: B, conversaId: dela.conversa.id, config: { vip: {}, textos: {}, regras_categoria: {} }, estado: {} };
  for (const [nome, input] of [['buscar_ou_criar_cliente', {}], ['registrar_briefing', { produto_modelo: 'x' }], ['transferir_para_equipe', { motivo: 'outro', resumo: 'x' }], ['registrar_id_shopee', { id_pedido: 'ABCDEFGH1234' }], ['consultar_cliente_vip', {}]]) {
    await assert.rejects(() => executarFerramenta(pool, ctxB, nome, input), /conversa não encontrada/, nome);
  }
  assert.equal((await pool.query('select count(*)::int n from crm_clientes where tenant_id = $1', [B])).rows[0].n, 0);
  assert.equal((await pool.query('select count(*)::int n from crm_pedidos where tenant_id = $1', [B])).rows[0].n, 0);
  assert.equal((await pool.query('select count(*)::int n from crm_handoffs where tenant_id = $1', [B])).rows[0].n, 0);
});

test('VIP e status de pedido não enxergam dados de outra conta', opts, async () => {
  // cliente VIP na conta B com o MESMO telefone; a conversa é da conta A e não deve herdar a tag
  const x = await novaConversa(A, [{ texto: 'oi' }]);
  const { rows: [t] } = await pool.query("insert into crm_tags (tenant_id, nome) values ($1, 'VIP') returning id", [B]);
  const { rows: [cb] } = await pool.query('insert into crm_clientes (tenant_id, nome, telefone) values ($1, $2, $3) returning id', [B, 'Outra', x.conversa.telefone_e164]);
  await pool.query('insert into crm_clientes_tags (cliente_id, tag_id) values ($1, $2)', [cb.id, t.id]);
  const ctx = { tenantId: A, conversaId: x.conversa.id, config: (await pool.query('select * from crm_agente_config where tenant_id = $1', [A])).rows[0], estado: {} };
  const r = await executarFerramenta(pool, ctx, 'consultar_cliente_vip', {});
  assert.equal(r.vip, false);
});

test('status de pedido: sem status_automatico o modelo não recebe o andamento', opts, async () => {
  const x = await novaConversa(A, [{ texto: 'cadê meu pedido?' }]);
  const ctx = { tenantId: A, conversaId: x.conversa.id, config: (await pool.query('select * from crm_agente_config where tenant_id = $1', [A])).rows[0], estado: {} };
  const cli = await executarFerramenta(pool, ctx, 'buscar_ou_criar_cliente', {});
  assert.equal(cli.ok, true);
  const { rows: [et] } = await pool.query('select id from crm_etapas where tenant_id = $1', [A]);
  const { rows: [{ proximo }] } = await pool.query('select coalesce(max(numero), 0) + 1 as proximo from crm_pedidos where tenant_id = $1', [A]);
  await pool.query('insert into crm_pedidos (tenant_id, cliente_id, etapa_id, origem, numero) values ($1, $2, $3, $4, $5)', [A, ctx.estado.clienteId, et.id, 'WhatsApp', proximo]);
  const r = await executarFerramenta(pool, ctx, 'consultar_status_pedido', {});
  assert.equal(r.status, undefined);
  assert.equal(r.registrado_para_equipe, true);
  assert.equal(ctx.estado.statusConsultado.etapa, 'A fazer');
  ctx.config = { ...ctx.config, flags: { status_automatico: true } };
  assert.equal((await executarFerramenta(pool, ctx, 'consultar_status_pedido', {})).status, 'A fazer');
});

test('ID Shopee: valida formato, marca aguardando conferência e não duplica pedido importado', opts, async () => {
  const x = await rodar(A, [{ texto: 'comprei na shopee, id 26100705XVF3PW' }], [toolUse('registrar_id_shopee', { id_pedido: '26100705XVF3PW' }), falou('Registrei! A equipe vai conferir. 🩵')]);
  const { rows: [p] } = await pool.query("select * from crm_pedidos where tenant_id = $1 and identificador_externo = '26100705XVF3PW'", [A]);
  assert.equal(p.origem, 'Shopee');
  assert.equal(p.aguardando_conferencia, true);
  assert.equal(p.rascunho, true);
  const ruim = await rodar(A, [{ texto: 'id é 12' }], [toolUse('registrar_id_shopee', { id_pedido: '12' }), falou('Pode conferir o ID?')]);
  assert.match(ruim.ia.chamadas[1].messages.at(-1).content[0].content, /inválido/);
  assert.equal(ruim.ia.chamadas[1].messages.at(-1).content[0].is_error, true);

  // pedido igual já veio da importação: nada de duplicar
  const y = await novaConversa(A, [{ texto: 'meu id 26100705XVF3PW' }]);
  const ctx = { tenantId: A, conversaId: y.conversa.id, config: {}, estado: {} };
  const r = await executarFerramenta(pool, ctx, 'registrar_id_shopee', { id_pedido: '26100705XVF3PW' });
  assert.equal(r.ja_existe, true);
  assert.equal((await pool.query("select count(*)::int n from crm_pedidos where tenant_id = $1 and identificador_externo = '26100705XVF3PW'", [A])).rows[0].n, 1);
});

test('só áudio/figurinha: pede texto sem chamar o modelo e encaminha', opts, async () => {
  const x = await rodar(A, [{ tipo: 'audio', texto: '[audio]' }], []);
  assert.equal(x.ia.chamadas.length, 0);
  assert.equal(x.r.resposta, seed.config.textos.somente_texto);
  assert.equal((await handoffs(A, x.conversa.id))[0].motivo, 'midia_nao_suportada');
});

test('imagem recebida: anexada ao pedido rascunho, encaminhada, e o modelo não vê o arquivo', opts, async () => {
  const c0 = await novaConversa(A, []);
  const { rows: [anexo] } = await pool.query(
    "insert into crm_anexos (tenant_id, chave_armazenamento, nome_arquivo, mime, tamanho) values ($1, $2, 'logo.png', 'image/png', 10) returning id", [A, `${A}/2026-10-12/x-logo.png`]);
  const { rows: [m] } = await pool.query(
    `insert into crm_mensagens_whatsapp (tenant_id, telefone_e164, direcao, tipo, conteudo, wamid, autor, anexo_id, midia)
     values ($1, $2, 'recebida', 'imagem', 'minha logo', $3, 'cliente', $4, '{"mediaId":"M9"}') returning *`, [A, c0.conversa.telefone_e164, `wamid.${crypto.randomUUID()}`, anexo.id]);
  const ia = iaFalsa([falou('Obrigada pelo envio da logo! A equipe vai analisar. Qual o tamanho que você precisa?')]);
  const r = await executarTurno({ pool, tenantId: A, conversa: c0.conversa, mensagens: [m] }, { ia, enviarTexto: async () => true, log: () => {} });
  assert.equal(r.bloqueada, false);
  const { rows: [a] } = await pool.query('select pedido_id from crm_anexos where id = $1', [anexo.id]);
  assert.ok(a.pedido_id);
  const { rows: arq } = await pool.query('select caminho_arquivo from crm_pedidos_arquivos where pedido_id = $1', [a.pedido_id]);
  assert.equal(arq[0].caminho_arquivo, `agente/${A}/2026-10-12/x-logo.png`);
  // Mesma agregação usada em GET /crm/api/pedidos e /crm/api/pedidos/:id
  // (index.js) — o usuário do CRM precisa ver/baixar o anexo na ficha do pedido.
  const { rows: [{ arquivos }] } = await pool.query(
    `select coalesce((
       select json_agg(json_build_object('id', ar.id, 'nome_arquivo', ar.nome_arquivo, 'tipo_mime', ar.tipo_mime) order by ar.criado_em)
       from crm_pedidos_arquivos ar where ar.pedido_id = p.id
     ), '[]') as arquivos
     from crm_pedidos p where p.id = $1`, [a.pedido_id]);
  assert.equal(arquivos.length, 1);
  assert.equal(arquivos[0].nome_arquivo, 'logo.png');
  assert.equal(arquivos[0].tipo_mime, 'image/png');
  assert.equal((await handoffs(A, c0.conversa.id))[0].motivo, 'arquivo_recebido');
  assert.equal(typeof ia.chamadas[0].messages[0].content, 'string'); // só texto, sem bloco de imagem
  assert.match(ia.chamadas[0].messages[0].content, /anexado ao pedido/);
});

test('prompt: camadas com cache, sem dados pessoais e CPF higienizado', opts, async () => {
  const x = await rodar(A, [{ texto: 'meu cpf é 123.456.789-09, email a@b.com' }], [falou('Anotado! Qual produto você quer?')]);
  const p = x.ia.chamadas[0];
  assert.equal(p.model, 'claude-haiku-5-5');
  assert.equal(p.system[0].text, 'SISTEMA TESTE');
  assert.ok(p.system[1].cache_control);
  assert.match(p.system[1].text, /VOZ TESTE/);
  assert.equal(p.system[2].cache_control, undefined); // contexto dinâmico fica depois do cache
  const tudo = JSON.stringify(p);
  assert.doesNotMatch(tudo, /123\.456\.789-09/);
  assert.match(tudo, /CPF removido/);
  assert.doesNotMatch(p.system[2].text, new RegExp(x.conversa.telefone_e164.replace('+', '\\+')));
  assert.match(p.system[2].text, /Primeira mensagem desta conversa: sim/);
  assert.equal(p.tools.length, FERRAMENTAS.length);
  assert.equal(p.messages[0].role, 'user');
});

test('máximo de 4 iterações: a última rodada força texto (tool_choice none)', opts, async () => {
  const x = await rodar(A, [{ texto: 'oi' }], [
    toolUse('buscar_ou_criar_cliente', {}), toolUse('buscar_ou_criar_cliente', {}), toolUse('buscar_ou_criar_cliente', {}), falou('Oi! Como posso ajudar?'),
  ]);
  assert.equal(x.ia.chamadas.length, 4);
  assert.equal(x.ia.chamadas[2].tool_choice, undefined);
  assert.deepEqual(x.ia.chamadas[3].tool_choice, { type: 'none' });
  assert.equal(x.r.bloqueada, false);
});

test('modelo preso em ferramentas ou recusando: encaminha em vez de responder', opts, async () => {
  const preso = await rodar(A, [{ texto: 'oi' }], [toolUse('consultar_status_pedido', {}), toolUse('consultar_status_pedido', {}), toolUse('consultar_status_pedido', {}), toolUse('consultar_status_pedido', {})]);
  assert.equal(preso.r.bloqueada, true);
  assert.equal(preso.r.resposta, ENCAMINHAMENTO);
  assert.equal((await handoffs(A, preso.conversa.id))[0].motivo, 'falha_agente');
  const recusa = await rodar(A, [{ texto: 'oi' }], [{ stop_reason: 'refusal', content: [], usage: { input_tokens: 10, output_tokens: 0 }, stop_details: { type: 'refusal', category: null } }]);
  assert.equal(recusa.r.bloqueada, true);
  assert.equal((await handoffs(A, recusa.conversa.id))[0].motivo, 'falha_agente');
});

test('modo automático: envia dentro da janela; fora dela não envia e encaminha', opts, async () => {
  await pool.query("update crm_agente_config set modo = 'automatico' where tenant_id = $1", [A]);
  await pool.query("insert into crm_whatsapp_numeros (phone_number_id, tenant_id) values ($1, $2) on conflict do nothing", [`pn-auto-${A.slice(0, 6)}`, A]);
  try {
    const agoraReal = { agora: () => new Date() }; // a janela de 24 h é relativa ao relógio do banco
    const ok = await rodar(A, [{ texto: 'oi' }], [falou('Oi! Sou a assistente virtual da Basic 3D Print. Como posso ajudar?')], {}, agoraReal);
    assert.equal(ok.envios.length, 1);
    assert.equal(ok.envios[0].to, ok.conversa.telefone_e164);
    assert.equal(ok.envios[0].phoneNumberId, `pn-auto-${A.slice(0, 6)}`);
    const { rows: [saida] } = await pool.query("select autor, direcao, tokens_in from crm_mensagens_whatsapp where tenant_id = $1 and telefone_e164 = $2 and direcao = 'enviada'", [A, ok.conversa.telefone_e164]);
    assert.equal(saida.autor, 'agente');
    assert.equal(saida.tokens_in, 120);

    const velha = await rodar(A, [{ texto: 'oi de novo' }], [falou('Oi! Posso ajudar?')], { janelaHoras: -1 }, agoraReal);
    assert.equal(velha.envios.length, 0);
    assert.equal((await handoffs(A, velha.conversa.id))[0].motivo, 'janela_expirada');
  } finally {
    await pool.query("update crm_agente_config set modo = 'rascunho' where tenant_id = $1", [A]);
  }
});

test('bloqueado pelo filtro no modo automático: o que sai é o encaminhamento, nunca o texto original', opts, async () => {
  await pool.query("update crm_agente_config set modo = 'automatico' where tenant_id = $1", [A]);
  try {
    const x = await rodar(A, [{ texto: 'quanto é o frete?' }], [falou('O frete para sua cidade é R$ 20.')]);
    assert.deepEqual(x.envios.map((e) => e.texto), [ENCAMINHAMENTO]);
  } finally {
    await pool.query("update crm_agente_config set modo = 'rascunho' where tenant_id = $1", [A]);
  }
});

test('limite de turnos: estourou, a equipe assume e o modelo não é chamado', opts, async () => {
  await pool.query("update crm_agente_config set limites = '{\"max_turnos\": 1}' where tenant_id = $1", [B]);
  const c = await novaConversa(B, [{ texto: 'oi' }]);
  const ia = iaFalsa([falou('Oi! Como posso ajudar?')]);
  const d = { ia, enviarTexto: async () => true, log: () => {} };
  const primeiro = await executarTurno({ pool, tenantId: B, conversa: c.conversa, mensagens: c.mensagens }, d);
  assert.ok(primeiro.execucaoId);
  const segundo = await executarTurno({ pool, tenantId: B, conversa: c.conversa, mensagens: c.mensagens }, d);
  assert.equal(segundo.limite, 'turnos');
  assert.equal(ia.chamadas.length, 1);
  assert.equal((await handoffs(B, c.conversa.id))[0].motivo, 'limite_turnos');
});

test('teto diário de tokens: estourou, encaminha sem chamar o modelo', opts, async () => {
  await pool.query("update crm_agente_config set limites = '{\"teto_diario_tokens\": 100}' where tenant_id = $1", [B]);
  const c = await novaConversa(B, [{ texto: 'oi' }]);
  const ia = iaFalsa([]);
  const r = await executarTurno({ pool, tenantId: B, conversa: c.conversa, mensagens: c.mensagens }, { ia, enviarTexto: async () => true, log: () => {} });
  assert.equal(r.limite, 'custo');
  assert.equal(ia.chamadas.length, 0);
});

test('modo desligado: o executor não faz nada', opts, async () => {
  await pool.query("update crm_agente_config set modo = 'desligado' where tenant_id = $1", [B]);
  const c = await novaConversa(B, [{ texto: 'oi' }]);
  const ia = iaFalsa([]);
  const r = await executarTurno({ pool, tenantId: B, conversa: c.conversa, mensagens: c.mensagens }, { ia, enviarTexto: async () => true, log: () => {} });
  assert.equal(r.ignorado, true);
  assert.equal(ia.chamadas.length, 0);
});

test('regra de pausa: conversa com humano não roda o agente (via processador)', opts, async () => {
  const c = await novaConversa(A, [{ texto: 'e aí?' }], { situacao: 'humano' });
  let chamou = false;
  const r = await processarConversa(pool, A, c.conversa.id, { executarAgente: async () => { chamou = true; }, log: () => {} });
  assert.equal(r.pausado, true);
  assert.equal(chamou, false);
});

test('prometeu encaminhar sem chamar a ferramenta: rede de proteção cria o handoff', opts, async () => {
  const x = await rodar(A, [{ texto: 'preciso de ajuda com uma coisa' }], [falou('Claro! Vou encaminhar você para a nossa equipe agora mesmo. 🩵')]);
  const h = await handoffs(A, x.conversa.id);
  assert.equal(h.length, 1);
  assert.equal(h[0].motivo, 'outro');
  assert.match(h[0].resumo, /preciso de ajuda/);
  assert.equal(x.r.ferramentas.at(-1).implicito, true);
  // resposta normal sobre briefing não vira handoff
  const y = await rodar(A, [{ texto: 'quero um chaveiro' }], [falou('A equipe analisa a referência e apresenta uma proposta antes de produzir. Qual o nome?')]);
  assert.equal((await handoffs(A, y.conversa.id)).length, 0);
  // quando o modelo já chamou a ferramenta, não duplica
  const z = await rodar(A, [{ texto: 'reclamação' }], [toolUse('transferir_para_equipe', { motivo: 'reclamacao', resumo: 'x' }), falou('Vou encaminhar seu caso para a equipe. 🩵')]);
  const hz = await handoffs(A, z.conversa.id);
  assert.equal(hz.length, 1);
  assert.equal(hz[0].motivo, 'reclamacao');
});

test('fora do horário: aviso de recebimento é acrescentado uma vez por período, se o modelo esquecer', opts, async () => {
  const fora = { agora: () => new Date('2026-10-12T22:00:00Z') }; // 19:00 em São Paulo
  const aviso = seed.config.mensagem_fora_horario;
  const c = await novaConversa(A, [{ texto: 'oi, quero um cortador' }]);
  const d = { enviarTexto: async () => true, log: () => {}, ...fora };
  const r1 = await executarTurno({ pool, tenantId: A, conversa: c.conversa, mensagens: c.mensagens }, { ...d, ia: iaFalsa([falou('Oi! Sou a assistente virtual da Basic 3D Print. Qual modelo?')]) });
  assert.ok(r1.resposta.startsWith(aviso));
  assert.ok(r1.resposta.endsWith("Qual modelo?"));
  const r2 = await executarTurno({ pool, tenantId: A, conversa: c.conversa, mensagens: c.mensagens }, { ...d, ia: iaFalsa([falou('Anotado! Para qual data?')]) });
  assert.equal(r2.resposta, 'Anotado! Para qual data?'); // já avisou neste período
  const c2 = await novaConversa(A, [{ texto: 'oi' }]);
  const r3 = await executarTurno({ pool, tenantId: A, conversa: c2.conversa, mensagens: c2.mensagens }, { ...d, ia: iaFalsa([falou('Recebi sua mensagem! A equipe responde no próximo período. Qual modelo?')]) });
  assert.equal(r3.resposta.startsWith(aviso), false); // modelo já avisou: não duplica
  const { rows: [e] } = await pool.query('select aviso_fora_horario from crm_agente_execucoes where id = $1', [r3.execucaoId]);
  assert.equal(e.aviso_fora_horario, true);
});

test('auditoria: guarda o texto original do modelo quando o filtro bloqueia', opts, async () => {
  const x = await rodar(A, [{ texto: 'quanto é?' }], [falou('Fica R$ 40,00 cada.')]);
  const { rows: [e] } = await pool.query('select resposta_original, resposta_proposta from crm_agente_execucoes where id = $1', [x.r.execucaoId]);
  assert.equal(e.resposta_original, 'Fica R$ 40,00 cada.');
  assert.equal(e.resposta_proposta, ENCAMINHAMENTO);
});

const { detectarGatilhos, extrairIdShopee, perguntaComercial } = require('../lib/agente/gatilhos');

test('gatilhos: detecta os casos de encaminhamento obrigatório e ignora conversa comum', () => {
  const m = (t, o) => detectarGatilhos(t, o)[0];
  assert.equal(m('Prefiro falar com uma atendente de verdade'), 'pedido_humano');
  assert.equal(m('o pedido chegou quebrado'), 'produto_danificado_ou_diferente');
  assert.equal(m('quero reembolso, que absurdo'), 'reclamacao');
  assert.equal(m('Preciso pra amanhã cedo'), 'urgencia');
  assert.equal(m('tem desconto pra quantidade?'), 'negociacao_desconto');
  assert.equal(m('cadê meu pedido?'), 'andamento_pedido');
  assert.equal(m('meu pedido está atrasado'), 'pedido_atrasado');
  assert.equal(m('tem desconto?', { vipConfirmado: true }), undefined);
  for (const ok of ['Oi, quero um cortador de coração', 'Pode ser dia 30 de novembro? Moro em Uberlândia', 'Quero 3 chaveiros com os nomes Ana e Bia', 'Meu CEP é 38400-000']) {
    assert.deepEqual(detectarGatilhos(ok), [], ok);
  }
  assert.equal(perguntaComercial('Qual o prazo?'), true);
  assert.equal(perguntaComercial('quero um chaveiro'), false);
});

test('gatilhos: ID Shopee só com contexto e formato plausível', () => {
  assert.equal(extrairIdShopee('Comprei pela Shopee, meu pedido é 26100705xvf3pw'), '26100705XVF3PW');
  assert.equal(extrairIdShopee('meu telefone é 34999998888'), null);
  assert.equal(extrairIdShopee('quero um chaveiro, código ABCDEFGHIJKL'), null); // sem dígito
  assert.equal(extrairIdShopee('oi 26100705XVF3PW'), null); // sem contexto
});

test('modelo que só responde em texto: o código garante o handoff do gatilho e registra o ID Shopee', opts, async () => {
  const urg = await rodar(A, [{ texto: 'Preciso do pedido amanhã cedo, dá?' }], [falou('Entendi! Qual produto você precisa?')]);
  const h = await handoffs(A, urg.conversa.id);
  assert.equal(h.length, 1);
  assert.equal(h[0].motivo, 'urgencia');
  assert.match(urg.r.resposta, /equipe já foi avisada/); // a cliente fica sabendo
  assert.equal(urg.r.ferramentas.at(-1).implicito, true);

  const rec = await rodar(A, [{ texto: 'Meu pedido chegou quebrado!' }], [falou('Sinto muito! A equipe vai cuidar disso. Pode mandar uma foto?')]);
  assert.equal((await handoffs(A, rec.conversa.id))[0].motivo, 'produto_danificado_ou_diferente');
  assert.doesNotMatch(rec.r.resposta, /já foi avisada/); // já disse "equipe": não repete

  const shp = await rodar(A, [{ texto: 'Comprei na shopee, ID 99887766ABCD12' }], [falou('Recebi o ID! A equipe confere.')]);
  const { rows: [p] } = await pool.query("select origem, aguardando_conferencia from crm_pedidos where tenant_id = $1 and identificador_externo = '99887766ABCD12'", [A]);
  assert.deepEqual(p, { origem: 'Shopee', aguardando_conferencia: true });
  assert.equal(shp.r.ferramentas.some((f) => f.nome === 'registrar_id_shopee' && f.implicito), true);
});

test('pergunta comercial: encaminha só depois que há briefing mínimo (produto + quantidade)', opts, async () => {
  const sem = await rodar(A, [{ texto: 'Qual o prazo de entrega?' }], [falou('Me conta o modelo e a quantidade, por favor?')]);
  assert.equal((await handoffs(A, sem.conversa.id)).length, 0);
  const com = await rodar(A, [{ texto: 'Ok. E qual o valor total?' }], [
    toolUse('registrar_briefing', { produto_modelo: 'Cortador de estrela', quantidade: 3 }),
    falou('Anotado! A equipe te passa isso junto com o orçamento.'),
  ]);
  assert.equal((await handoffs(A, com.conversa.id))[0].motivo, 'pergunta_valor_prazo_frete_pagamento');
});

test('VIP verificado: pedido de desconto não vira encaminhamento automático', opts, async () => {
  const x = await novaConversa(A, [{ texto: 'sou VIP, tenho desconto?' }], { nome: 'Vera Lima' });
  const { rows: [tag] } = await pool.query("select id from crm_tags where tenant_id = $1 and nome = 'VIP'", [A]);
  const cli = await executarFerramenta(pool, { tenantId: A, conversaId: x.conversa.id, config: (await pool.query('select * from crm_agente_config where tenant_id = $1', [A])).rows[0], estado: {} }, 'buscar_ou_criar_cliente', {});
  assert.equal(cli.ok, true);
  const { rows: [c] } = await pool.query('select cliente_id from crm_conversas_whatsapp where id = $1', [x.conversa.id]);
  await pool.query('insert into crm_clientes_tags (cliente_id, tag_id) values ($1, $2)', [c.cliente_id, tag.id]);
  const ia = iaFalsa([toolUse('consultar_cliente_vip', {}), falou(FRASE_VIP)]);
  const conv = (await pool.query('select * from crm_conversas_whatsapp where id = $1', [x.conversa.id])).rows[0];
  const r = await executarTurno({ pool, tenantId: A, conversa: conv, mensagens: x.mensagens }, { ia, enviarTexto: async () => true, log: () => {} });
  assert.equal(r.resposta, FRASE_VIP);
  assert.equal((await handoffs(A, x.conversa.id)).length, 0);
});

test('filtro: ecoar o "amanhã" da cliente passa; prometer prazo continua barrado', () => {
  assert.equal(filtrarResposta('Entendi que a urgência é amanhã cedo. Qual o produto?').ok, true);
  for (const ruim of ['Entrego amanhã', 'Fica pronto amanhã sim!', 'Chega amanhã cedo', 'Garanto amanhã']) assert.equal(filtrarResposta(ruim).ok, false, ruim);
});

test('bloqueio do filtro não sobrescreve o motivo do gatilho (urgência continua urgência)', opts, async () => {
  const x = await rodar(A, [{ texto: 'Preciso do pedido amanhã cedo' }], [falou('Sobre ficar pronto amanhã, a equipe confirma. Qual o produto?')]);
  assert.equal(x.r.bloqueada, true);
  const h = await handoffs(A, x.conversa.id);
  assert.equal(h.length, 1);
  assert.equal(h[0].motivo, 'urgencia');
});
