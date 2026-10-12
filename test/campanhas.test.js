const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizarCampanha, erroConteudo, formatarPremio, aplicarVariaveis, montarParametrosModelo,
  embaralharSeguro, enviarParaClientes, prepararDisparo, sortearCampanha,
} = require('../lib/campanhas');

// Pool falso: responde só as queries que lib/campanhas.js + helpers fazem.
function poolFalso({ clientes = [], phoneNumberId = 'pn1', envioRecente = [], disparosUltimas24h = 0 } = {}) {
  const log = { envios: [], disparos: [], sorteios: [], updatesSegmento: [] };
  return {
    log,
    query: async (sql, params) => {
      if (/^select phone_number_id from crm_whatsapp_numeros/.test(sql)) return { rows: phoneNumberId ? [{ phone_number_id: phoneNumberId }] : [] };
      if (/^select 1 from crm_whatsapp_envios/.test(sql)) return { rows: envioRecente.includes(params[0]) ? [{}] : [] };
      if (/^insert into crm_whatsapp_envios/.test(sql)) return { rows: [] };
      if (/^insert into crm_whatsapp_disparos/.test(sql)) { log.disparos.push({ telefone: params[1], gatilho: params[3], status: params[4] }); return { rows: [] }; }
      if (/^insert into crm_campanhas_envios/.test(sql)) {
        log.envios.push({ clienteId: params[2], finalidade: params[3], canal: params[4], status: params[6], motivo: params[7] });
        return { rows: [] };
      }
      if (/from crm_clientes c where/.test(sql)) return { rows: clientes };
      if (/select count\(\*\)::int as total from crm_whatsapp_disparos/.test(sql)) return { rows: [{ total: disparosUltimas24h }] };
      if (/^insert into crm_sorteios/.test(sql)) {
        const linha = { id: 's1', segmento_id: params[1], participantes: JSON.parse(params[2]), vencedores: JSON.parse(params[3]), premio: params[5] ? JSON.parse(params[5]) : null, notificacao: null };
        log.sorteios.push(linha);
        return { rows: [linha] };
      }
      if (/^update crm_sorteios set notificacao/.test(sql)) {
        log.sorteios[0].notificacao = JSON.parse(params[1]);
        return { rows: [log.sorteios[0]] };
      }
      if (/^update crm_segmentos/.test(sql)) { log.updatesSegmento.push(params); return { rows: [] }; }
      throw new Error(`query inesperada: ${sql}`);
    },
  };
}

const cliente = (id, extra = {}) => ({ id, nome: `Cliente ${id} Silva`, telefone: `+55349999000${id}`, email: `c${id}@x.com`, bloqueado: false, ...extra });

test('normalizarCampanha: nome obrigatório, tipo e canal validados, padrão disparo', () => {
  assert.match(normalizarCampanha({ nome: '  ' }).erro, /Nome/);
  assert.match(normalizarCampanha({ nome: 'x', tipo: 'outro' }).erro, /Tipo/);
  assert.match(normalizarCampanha({ nome: 'x', canal: 'sms' }).erro, /Canal/);
  const ok = normalizarCampanha({ nome: ' Black Friday ', filtros: { cidade: 'Uberlândia' }, canal: 'email', assunto: 'Oi', corpo: 'Olá {{nome}}' });
  assert.equal(ok.valores.nome, 'Black Friday');
  assert.equal(ok.valores.tipo, 'disparo');
  assert.equal(ok.valores.premio_tipo, null);
  assert.deepEqual(ok.valores.filtros, { cidade: 'Uberlândia' });
});

test('normalizarCampanha: sorteio exige prêmio válido e quantidade de vencedores', () => {
  const base = { nome: 'Sorteio', tipo: 'sorteio' };
  assert.match(normalizarCampanha(base).erro, /prêmio/);
  assert.match(normalizarCampanha({ ...base, premio_tipo: 'brinde' }).erro, /brinde/);
  assert.match(normalizarCampanha({ ...base, premio_tipo: 'desconto_percentual' }).erro, /valor/);
  assert.match(normalizarCampanha({ ...base, premio_tipo: 'desconto_percentual', premio_valor: 150 }).erro, /100%/);
  assert.match(normalizarCampanha({ ...base, premio_tipo: 'brinde', premio_descricao: 'Caneca', qtd_vencedores: 0 }).erro, /vencedores/);
  const ok = normalizarCampanha({ ...base, premio_tipo: 'desconto_valor', premio_valor: '50', qtd_vencedores: 3 });
  assert.equal(ok.valores.premio_valor, 50);
  assert.equal(ok.valores.qtd_vencedores, 3);
  assert.equal(normalizarCampanha({ ...base, premio_tipo: 'brinde', premio_descricao: 'Caneca' }).valores.qtd_vencedores, 1);
});

test('formatarPremio descreve brinde e descontos', () => {
  assert.equal(formatarPremio({ premio_tipo: 'brinde', premio_descricao: 'Caneca personalizada' }), 'Caneca personalizada');
  assert.equal(formatarPremio({ premio_tipo: 'desconto_percentual', premio_valor: '20.00' }), '20% de desconto');
  assert.match(formatarPremio({ premio_tipo: 'desconto_valor', premio_valor: 50, premio_descricao: 'na próxima compra' }), /R\$\s?50,00 de desconto — na próxima compra/);
  assert.equal(formatarPremio({}), '');
});

test('erroConteudo exige modelo (WhatsApp) ou assunto+texto (e-mail)', () => {
  assert.match(erroConteudo({ canal: null }), /canal/);
  assert.match(erroConteudo({ canal: 'whatsapp' }), /modelo/);
  assert.equal(erroConteudo({ canal: 'whatsapp', whatsapp_template: 'promo' }), null);
  assert.match(erroConteudo({ canal: 'email', assunto: 'Oi' }), /e-mail/);
  assert.equal(erroConteudo({ canal: 'email', assunto: 'Oi', corpo: 'Texto' }), null);
});

test('aplicarVariaveis troca {{nome}} e esvazia variável desconhecida', () => {
  assert.equal(aplicarVariaveis('Olá {{ nome }}, {{premio}}{{x}}!', { nome: 'Ana', premio: '10%' }), 'Olá Ana, 10%!');
});

test('montarParametrosModelo: nomeado casa por nome, posicional completa/corta pela contagem', () => {
  const dados = { cliente: 'Ana Souza', premio: 'Caneca', nome: 'Ana' };
  assert.deepEqual(
    montarParametrosModelo({ parametros_nomeados: true, parametros_corpo: ['nome', 'premio', 'outro'] }, dados),
    [{ nome: 'nome', nomeado: true, valor: 'Ana' }, { nome: 'premio', nomeado: true, valor: 'Caneca' }, { nome: 'outro', nomeado: true, valor: '' }]
  );
  assert.deepEqual(montarParametrosModelo({ parametros_nomeados: false, parametros_corpo: ['1'] }, dados), [{ nomeado: false, valor: 'Ana Souza' }]);
  assert.equal(montarParametrosModelo({ parametros_nomeados: false, parametros_corpo: ['1', '2', '3'] }, dados).length, 3);
});

test('embaralharSeguro mantém os mesmos elementos', () => {
  const lista = [1, 2, 3, 4, 5, 6];
  assert.deepEqual([...embaralharSeguro(lista)].sort(), lista);
  assert.deepEqual(lista, [1, 2, 3, 4, 5, 6]);
});

test('e-mail: envia, ignora bloqueado e sem e-mail, conta erro do provedor', async () => {
  const pool = poolFalso();
  const enviados = [];
  const deps = { enviarEmail: async (m) => { enviados.push(m); return m.to !== 'c4@x.com'; } };
  const campanha = { id: 'k1', canal: 'email', assunto: 'Oi {{nome}}', corpo: 'Olá {{nome}}\n<b>promo</b>' };
  const clientes = [cliente(1), cliente(2, { bloqueado: true }), cliente(3, { email: null }), cliente(4)];
  const r = await enviarParaClientes(pool, { tenantId: 't1', campanha, clientes, deps });
  assert.deepEqual(r, { enviados: 1, erros: 1, ignorados: 2 });
  assert.equal(enviados[0].subject, 'Oi Cliente');
  assert.match(enviados[0].html, /Olá Cliente<br>&lt;b&gt;promo&lt;\/b&gt;/); // html escapado
  assert.deepEqual(pool.log.envios.map((e) => e.status), ['enviado', 'ignorado', 'ignorado', 'erro']);
});

test('WhatsApp: respeita a trava de 24h no disparo, mas não no aviso do sorteio', async () => {
  const campanha = { id: 'k1', canal: 'whatsapp', whatsapp_template: 'promo' };
  const chamadas = [];
  const deps = { listarTemplates: async () => [{ nome: 'promo', status: 'APPROVED', corpo: 'Oi {{1}}', parametros_corpo: ['1'], parametros_nomeados: false }], enviarTemplate: async (a) => { chamadas.push(a); return true; } };
  const clientes = [cliente(1), cliente(2)];

  const pool1 = poolFalso({ envioRecente: [clientes[1].telefone] });
  const r1 = await enviarParaClientes(pool1, { tenantId: 't1', campanha, clientes, deps });
  assert.deepEqual(r1, { enviados: 1, erros: 0, ignorados: 1 });
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].parametrosCorpo[0].valor, 'Cliente 1 Silva');
  assert.ok(pool1.log.disparos.some((d) => d.status === 'bloqueado_24h' && d.gatilho === 'campanha'));

  const pool2 = poolFalso({ envioRecente: [clientes[1].telefone] });
  const r2 = await enviarParaClientes(pool2, { tenantId: 't1', campanha, clientes, finalidade: 'sorteio', deps });
  assert.deepEqual(r2, { enviados: 2, erros: 0, ignorados: 0 });
  assert.ok(pool2.log.disparos.every((d) => d.gatilho === 'sorteio'));
});

test('WhatsApp sem número vinculado lança antes de enviar qualquer coisa', async () => {
  const pool = poolFalso({ phoneNumberId: null });
  await assert.rejects(
    enviarParaClientes(pool, { tenantId: 't1', campanha: { id: 'k', canal: 'whatsapp', whatsapp_template: 'p' }, clientes: [cliente(1)], deps: { listarTemplates: async () => [], enviarTemplate: async () => true } }),
    /WhatsApp não conectado/
  );
  assert.equal(pool.log.envios.length, 0);
});

test('prepararDisparo barra campanha já enviada, sorteio, sem conteúdo e sem público', async () => {
  const pool = poolFalso({ clientes: [] });
  assert.equal((await prepararDisparo(pool, { tenantId: 't', campanha: { tipo: 'disparo', status: 'enviada', canal: 'email' } })).status, 409);
  assert.equal((await prepararDisparo(pool, { tenantId: 't', campanha: { tipo: 'disparo', status: 'enviando', canal: 'email' } })).status, 409);
  assert.match((await prepararDisparo(pool, { tenantId: 't', campanha: { tipo: 'sorteio', status: 'rascunho' } })).erro, /sorteio/);
  assert.match((await prepararDisparo(pool, { tenantId: 't', campanha: { tipo: 'disparo', status: 'rascunho', canal: null } })).erro, /canal/);
  assert.match((await prepararDisparo(pool, { tenantId: 't', campanha: { tipo: 'disparo', status: 'rascunho', canal: 'email', assunto: 'a', corpo: 'b', filtros: {} } })).erro, /Nenhum cliente/);
});

test('prepararDisparo (WhatsApp): modelo não aprovado e limite de conversas da Meta', async () => {
  const campanha = { tipo: 'disparo', status: 'rascunho', canal: 'whatsapp', whatsapp_template: 'promo', filtros: {} };
  const clientes = [cliente(1), cliente(2, { bloqueado: true }), cliente(3)];
  const modeloRuim = { listarTemplates: async () => [{ nome: 'promo', status: 'PENDING' }], buscarLimiteMensagens: async () => null };
  assert.match((await prepararDisparo(poolFalso({ clientes }), { tenantId: 't', campanha, deps: modeloRuim })).erro, /não está aprovado/);

  const modeloOk = [{ nome: 'promo', status: 'APPROVED' }];
  const apertado = { listarTemplates: async () => modeloOk, buscarLimiteMensagens: async () => 50 };
  const r = await prepararDisparo(poolFalso({ clientes, disparosUltimas24h: 49 }), { tenantId: 't', campanha, deps: apertado });
  assert.match(r.erro, /restam 1/);

  const livre = { listarTemplates: async () => modeloOk, buscarLimiteMensagens: async () => 1000 };
  const ok = await prepararDisparo(poolFalso({ clientes }), { tenantId: 't', campanha, deps: livre });
  assert.deepEqual(ok.clientes.map((c) => c.id), [1, 3]); // bloqueado fora
});

test('sortearCampanha: grava o sorteio com o prêmio e avisa os ganhadores', async () => {
  const clientes = [cliente(1), cliente(2), cliente(3), cliente(4, { bloqueado: true })];
  const pool = poolFalso({ clientes });
  const avisos = [];
  const deps = { enviarEmail: async (m) => { avisos.push(m); return true; } };
  const campanha = {
    id: 'k1', tipo: 'sorteio', canal: 'email', assunto: 'Você ganhou!', corpo: '{{nome}}, seu prêmio: {{premio}}',
    premio_tipo: 'desconto_percentual', premio_valor: '15', qtd_vencedores: 2, notificar_vencedores: true, filtros: {},
  };
  const { sorteio } = await sortearCampanha(pool, { tenantId: 't1', userId: 'u1', campanha, deps });
  assert.equal(sorteio.participantes.length, 3); // bloqueado não participa
  assert.equal(sorteio.vencedores.length, 2);
  assert.equal(sorteio.premio.texto, '15% de desconto');
  assert.equal(avisos.length, 2);
  assert.match(avisos[0].text, /seu prêmio: 15% de desconto/);
  assert.deepEqual(sorteio.notificacao, { canal: 'email', enviados: 2, erros: 0, ignorados: 0 });
  assert.ok(pool.log.envios.every((e) => e.finalidade === 'sorteio'));
  assert.equal(pool.log.updatesSegmento.length, 1);
});

test('sortearCampanha: sem aviso quando notificar=false ou sem canal; quantidade limitada ao público', async () => {
  const clientes = [cliente(1), cliente(2)];
  const campanha = { id: 'k1', tipo: 'sorteio', canal: 'email', assunto: 'a', corpo: 'b', premio_tipo: 'brinde', premio_descricao: 'Caneca', notificar_vencedores: true, filtros: {} };
  const pool = poolFalso({ clientes });
  const semAviso = await sortearCampanha(pool, { tenantId: 't', userId: 'u', campanha, quantidade: 10, notificar: false, deps: { enviarEmail: async () => { throw new Error('não deveria enviar'); } } });
  assert.equal(semAviso.sorteio.vencedores.length, 2);
  assert.equal(semAviso.sorteio.notificacao, null);

  const semCanal = await sortearCampanha(poolFalso({ clientes }), { tenantId: 't', userId: 'u', campanha: { ...campanha, canal: null } });
  assert.equal(semCanal.sorteio.notificacao, null);

  const vazio = await sortearCampanha(poolFalso({ clientes: [] }), { tenantId: 't', userId: 'u', campanha });
  assert.match(vazio.erro, /nenhum participante/);
});
