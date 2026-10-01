const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  dispararMudancaEtapa, dispararPedidoCriado, checarPedidosParados, checarAniversariantes,
  checarLimiteDisparos, montarParametros, renderizarCorpoTemplate,
} = require('../lib/automacoes');

// @kyvvohq/whatsapp cai em modo dev (sem META_WHATSAPP_TOKEN/META_PHONE_NUMBER_ID
// no ambiente de teste): enviarTemplate sempre retorna false, listarTemplates
// sempre retorna [] — sem precisar mockar rede, mesmo padrão já usado pelos
// outros testes deste repo que passam pela mesma dependência (ver
// test/bot-whatsapp.test.js).

function poolFalso({ phoneNumberId, envioRecente, disparosExistentes = [] } = {}) {
  const disparos = [...disparosExistentes];
  const envios = [];
  return {
    disparos,
    query: async (sql, params) => {
      if (/^select phone_number_id from crm_whatsapp_numeros/.test(sql)) {
        return { rows: phoneNumberId ? [{ phone_number_id: phoneNumberId }] : [] };
      }
      if (/^select 1 from crm_whatsapp_envios/.test(sql)) {
        return { rows: envioRecente ? [{}] : [] };
      }
      if (/^insert into crm_whatsapp_envios/.test(sql)) {
        envios.push({ tenantId: params[0], telefone: params[1] });
        return { rows: [] };
      }
      if (/^insert into crm_whatsapp_disparos/.test(sql)) {
        disparos.push({
          tenantId: params[0], telefoneE164: params[1], templateNome: params[2],
          gatilho: params[3], status: params[4], mensagemTexto: params[5], pedidoId: params[6],
        });
        return { rows: [] };
      }
      if (/^select 1 from crm_whatsapp_disparos where pedido_id/.test(sql)) {
        const [pedidoId, criadoDepoisDe] = params;
        const ja = disparos.some((d) => d.pedidoId === pedidoId && d.gatilho === 'pedido_parado' && new Date(d.criadoEm || 0) >= new Date(criadoDepoisDe));
        return { rows: ja ? [{}] : [] };
      }
      if (/^select 1 from crm_whatsapp_disparos\s+where tenant_id/.test(sql)) {
        const [tenantId, telefone] = params;
        const ja = disparos.some((d) => d.tenantId === tenantId && d.telefoneE164 === telefone && d.gatilho === 'aniversario_cliente');
        return { rows: ja ? [{}] : [] };
      }
      throw new Error('query inesperada: ' + sql);
    },
  };
}

test('montarParametros: template com parâmetro nomeado usa dados[nomeParam]', () => {
  const templateInfo = { parametros_nomeados: true, parametros_corpo: ['cliente', 'etapa'] };
  const params = montarParametros('mudanca_etapa', { cliente: 'Ana', etapa: 'Produção' }, templateInfo);
  assert.deepEqual(params, [
    { nome: 'cliente', nomeado: true, valor: 'Ana' },
    { nome: 'etapa', nomeado: true, valor: 'Produção' },
  ]);
});

test('montarParametros: sem template (ou posicional) cai no fallback por gatilho', () => {
  const params = montarParametros('pedido_criado', { cliente: 'Ana', pedido_valor: '99.00' }, null);
  assert.deepEqual(params, [
    { valor: 'Ana', nomeado: false },
    { valor: '99.00', nomeado: false },
  ]);
});

test('renderizarCorpoTemplate: substitui parâmetro nomeado no corpo', () => {
  const texto = renderizarCorpoTemplate('Oi {{cliente}}, seu pedido está em {{etapa}}!', [
    { nome: 'cliente', nomeado: true, valor: 'Ana' },
    { nome: 'etapa', nomeado: true, valor: 'Produção' },
  ]);
  assert.equal(texto, 'Oi Ana, seu pedido está em Produção!');
});

test('dispararMudancaEtapa: sem número de WhatsApp vinculado, não registra disparo', async () => {
  const pool = poolFalso({ phoneNumberId: null });
  // simula a automação já existindo — sobrescreve query pra essa parte do teste
  const automacao = { id: 'a1', gatilho: 'mudanca_etapa', etapa_id: 'etapa-1', ativo: true, whatsapp_template: 'confirma_pronto' };
  const originalQuery = pool.query;
  pool.query = async (sql, params) => {
    if (/^select \* from crm_automacoes where tenant_id = \$1 and gatilho = 'mudanca_etapa'/.test(sql)) {
      return { rows: [automacao] };
    }
    return originalQuery(sql, params);
  };

  await dispararMudancaEtapa(pool, {
    tenantId: 'tenant-1', pedidoId: 'pedido-1', etapaId: 'etapa-1', etapaNome: 'Pronto',
    cliente: { nome: 'Ana', telefone: '+5534999998888' },
  });

  assert.equal(pool.disparos.length, 0);
});

test('dispararPedidoCriado: com número vinculado mas sem credencial da Meta, registra disparo com status erro', async () => {
  const pool = poolFalso({ phoneNumberId: 'phone-123' });
  const automacao = { id: 'a2', gatilho: 'pedido_criado', etapa_id: null, ativo: true, whatsapp_template: 'confirma_pedido' };
  const originalQuery = pool.query;
  pool.query = async (sql, params) => {
    if (/^select \* from crm_automacoes where tenant_id = \$1 and gatilho = 'pedido_criado'/.test(sql)) {
      return { rows: [automacao] };
    }
    return originalQuery(sql, params);
  };

  await dispararPedidoCriado(pool, { tenantId: 'tenant-1', pedidoId: 'pedido-1', cliente: { nome: 'Ana', telefone: '+5534999998888' }, valorTotal: 150 });

  assert.equal(pool.disparos.length, 1);
  assert.equal(pool.disparos[0].status, 'erro'); // dev mode do @kyvvohq/whatsapp (sem token nos testes) nunca "envia" de verdade
  assert.equal(pool.disparos[0].gatilho, 'pedido_criado');
});

test('dispararPedidoCriado: já enviado nas últimas 24h, bloqueia sem chamar a Meta', async () => {
  const pool = poolFalso({ phoneNumberId: 'phone-123', envioRecente: true });
  const automacao = { id: 'a3', gatilho: 'pedido_criado', etapa_id: null, ativo: true, whatsapp_template: 'confirma_pedido' };
  const originalQuery = pool.query;
  pool.query = async (sql, params) => {
    if (/^select \* from crm_automacoes where tenant_id = \$1 and gatilho = 'pedido_criado'/.test(sql)) {
      return { rows: [automacao] };
    }
    return originalQuery(sql, params);
  };

  await dispararPedidoCriado(pool, { tenantId: 'tenant-1', pedidoId: 'pedido-2', cliente: { nome: 'Ana', telefone: '+5534999998888' } });

  assert.equal(pool.disparos.length, 1);
  assert.equal(pool.disparos[0].status, 'bloqueado_24h');
});

test('checarPedidosParados: pedido além do prazo_alerta_dias da etapa dispara automação', async () => {
  const automacao = { id: 'a4', tenant_id: 'tenant-1', gatilho: 'pedido_parado', etapa_id: 'etapa-2', etapa_nome: 'Aguardando pagamento', prazo_alerta_dias: 3, ativo: true, whatsapp_template: 'lembrete' };
  const pedido = { id: 'pedido-3', entrou_na_etapa_em: new Date(Date.now() - 5 * 86400000).toISOString(), cliente_nome: 'Bia', cliente_telefone: '+5534999997777' };

  const pool = poolFalso({ phoneNumberId: 'phone-123' });
  const originalQuery = pool.query;
  pool.query = async (sql, params) => {
    if (/^select a\.\*, e\.nome as etapa_nome, e\.prazo_alerta_dias/.test(sql)) return { rows: [automacao] };
    if (/^select p\.id, p\.entrou_na_etapa_em, c\.nome as cliente_nome/.test(sql)) return { rows: [pedido] };
    return originalQuery(sql, params);
  };

  await checarPedidosParados(pool);

  assert.equal(pool.disparos.length, 1);
  assert.equal(pool.disparos[0].pedidoId, 'pedido-3');
  assert.equal(pool.disparos[0].gatilho, 'pedido_parado');
});

test('checarPedidosParados: não repete aviso pro mesmo pedido na mesma estadia', async () => {
  const entrouNaEtapaEm = new Date(Date.now() - 5 * 86400000).toISOString();
  const automacao = { id: 'a5', tenant_id: 'tenant-1', gatilho: 'pedido_parado', etapa_id: 'etapa-2', etapa_nome: 'Aguardando pagamento', prazo_alerta_dias: 3, ativo: true, whatsapp_template: 'lembrete' };
  const pedido = { id: 'pedido-4', entrou_na_etapa_em: entrouNaEtapaEm, cliente_nome: 'Bia', cliente_telefone: '+5534999997777' };

  const pool = poolFalso({
    phoneNumberId: 'phone-123',
    disparosExistentes: [{ pedidoId: 'pedido-4', gatilho: 'pedido_parado', criadoEm: new Date().toISOString(), tenantId: 'tenant-1', telefoneE164: '+5534999997777' }],
  });
  const originalQuery = pool.query;
  pool.query = async (sql, params) => {
    if (/^select a\.\*, e\.nome as etapa_nome, e\.prazo_alerta_dias/.test(sql)) return { rows: [automacao] };
    if (/^select p\.id, p\.entrou_na_etapa_em, c\.nome as cliente_nome/.test(sql)) return { rows: [pedido] };
    return originalQuery(sql, params);
  };

  await checarPedidosParados(pool);

  assert.equal(pool.disparos.length, 1); // continua só o disparo pré-existente, nada novo
});

test('checarAniversariantes: cliente aniversariante hoje dispara, sem telefone é ignorado', async () => {
  const automacao = { id: 'a6', tenant_id: 'tenant-1', gatilho: 'aniversario_cliente', ativo: true, whatsapp_template: 'feliz_aniversario' };
  const clientes = [
    { id: 'cliente-1', nome: 'Carla', telefone: '+5534999996666' },
    { id: 'cliente-2', nome: 'Sem telefone', telefone: null },
  ];

  const pool = poolFalso({ phoneNumberId: 'phone-123' });
  const originalQuery = pool.query;
  pool.query = async (sql, params) => {
    if (/^select \* from crm_automacoes where gatilho = 'aniversario_cliente'/.test(sql)) return { rows: [automacao] };
    if (/^select id, nome, telefone from crm_clientes/.test(sql)) return { rows: clientes };
    return originalQuery(sql, params);
  };

  await checarAniversariantes(pool);

  assert.equal(pool.disparos.length, 1);
  assert.equal(pool.disparos[0].telefoneE164, '+5534999996666');
});

test('checarLimiteDisparos: sem META_WHATSAPP_TOKEN (ambiente de teste) não quebra e não notifica ninguém', async () => {
  // Mesmo raciocínio do comentário no topo do arquivo: sem o token, a
  // própria chamada à Meta (buscarLimiteMensagens) nem acontece de verdade
  // — a função devolve null e o tenant é pulado. Esse é o caminho real que
  // roda sempre que o checador periódico executa num ambiente sem a env var
  // (CI, dev local), então vale testar explicitamente que é seguro.
  let notificacoesChamadas = 0;
  const pool = {
    query: async (sql) => {
      if (/^select distinct tenant_id, phone_number_id from crm_whatsapp_numeros/.test(sql)) {
        return { rows: [{ tenant_id: 'tenant-1', phone_number_id: 'phone-123' }] };
      }
      notificacoesChamadas++;
      throw new Error('não deveria chegar aqui sem um limite conhecido: ' + sql);
    },
  };

  await checarLimiteDisparos(pool);

  assert.equal(notificacoesChamadas, 0);
});

test('checarLimiteDisparos: sem nenhum número vinculado, não faz nada', async () => {
  const pool = {
    query: async (sql) => {
      assert.match(sql, /^select distinct tenant_id, phone_number_id from crm_whatsapp_numeros/);
      return { rows: [] };
    },
  };
  await checarLimiteDisparos(pool); // não deve lançar
});
