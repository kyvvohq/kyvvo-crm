// Cobre o ponto de extensão novo de lib/agente/executor.js (perfil de
// agente por conta, crm_agente_config.perfil_agente) — garante que o
// bundle da Kyvvo (vendas/suporte/geral) funciona isolado do bundle da
// Basic 3D Print, sem precisar repetir toda a suíte de
// test/agente-executor.test.js (essa já cobre o bundle Basic3D sem
// alteração nenhuma — é a prova de zero regressão).
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const temBanco = !!process.env.DATABASE_URL;
const opts = temBanco ? {} : { skip: 'sem DATABASE_URL' };
const { pool, migrar } = require('../lib/db');
const { semearAgente } = require('../lib/agente/seed');
const { executarTurno } = require('../lib/agente/executor');
const { inicializarEtapasLeads } = require('../lib/leads');
const { FERRAMENTAS_KYVVO } = require('../lib/agente/ferramentas-kyvvo');

const seedKyvvo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'db', 'seeds', 'kyvvo-atendimento.json'), 'utf8'));
const C = crypto.randomUUID();
let seq = 0;

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

async function novaConversa(tenant, mensagens, { situacao = 'bot', janelaHoras = 24, nome = 'Fulano' } = {}) {
  const fone = `+5534988${String(++seq).padStart(6, '0')}`;
  const { rows: [conversa] } = await pool.query(
    `insert into crm_conversas_whatsapp (tenant_id, telefone_e164, estado, situacao, ultima_msg_cliente_em, janela_expira_em, nome_whatsapp)
     values ($1, $2, 'agente', $3, now(), now() + make_interval(hours => $4), $5) returning *`, [tenant, fone, situacao, janelaHoras, nome]);
  const ms = [];
  for (const m of mensagens) {
    const { rows: [msg] } = await pool.query(
      `insert into crm_mensagens_whatsapp (tenant_id, telefone_e164, direcao, tipo, conteudo, wamid, autor)
       values ($1, $2, 'recebida', $3, $4, $5, 'cliente') returning *`,
      [tenant, fone, m.tipo || 'texto', m.texto, `wamid.${crypto.randomUUID()}`]);
    ms.push(msg);
  }
  return { conversa, mensagens: ms };
}

async function rodar(tenant, mensagens, respostas, extra = {}) {
  const ia = iaFalsa(respostas);
  const envios = [];
  const c = await novaConversa(tenant, mensagens, extra);
  const r = await executarTurno({ pool, tenantId: tenant, conversa: c.conversa, mensagens: c.mensagens }, {
    ia, enviarTexto: async (p) => { envios.push(p); return true; }, log: () => {}, agora: () => new Date('2026-01-14T15:00:00Z'),
  });
  return { ...c, ia, envios, r };
}

before(async () => {
  if (!temBanco) return;
  await migrar();
  await semearAgente(pool, C, seedKyvvo, { modo: 'rascunho', conhecimento: { sistema: 'SISTEMA TESTE KYVVO', voz: 'VOZ TESTE' } });
  await inicializarEtapasLeads(pool, C);
});

after(async () => {
  if (!temBanco) return;
  for (const tab of ['crm_handoffs', 'crm_agente_execucoes', 'crm_eventos', 'crm_leads', 'crm_leads_etapas', 'crm_chamados',
    'crm_mensagens_whatsapp', 'crm_conversas_whatsapp', 'crm_clientes', 'crm_agente_conhecimento', 'crm_agente_config']) {
    await pool.query(`delete from ${tab} where tenant_id = $1`, [C]);
  }
  await pool.end();
});

describe('perfil kyvvo_atendimento — isolado do perfil basic3d', () => {
  test('FERRAMENTAS_KYVVO não inclui nenhuma ferramenta específica de impressão 3D', () => {
    const nomes = FERRAMENTAS_KYVVO.map((f) => f.name);
    assert.ok(nomes.includes('registrar_lead'));
    assert.ok(nomes.includes('abrir_chamado'));
    for (const proibido of ['registrar_briefing', 'registrar_id_shopee', 'consultar_cliente_vip', 'consultar_status_pedido', 'registrar_autorizacao_imagem']) {
      assert.ok(!nomes.includes(proibido), `ferramenta "${proibido}" (Basic3D) vazou pro bundle da Kyvvo`);
    }
  });

  test('registrar_lead cria o lead na etapa inicial e registra o evento com lead_id', opts, async () => {
    const x = await rodar(C, [{ texto: 'Oi, vi o Studio e queria saber mais pro meu salão' }], [
      toolUse('buscar_ou_criar_cliente', { nome: 'Joana' }),
      toolUse('registrar_lead', { produto_interesse: 'studio', empresa: 'Salão da Joana', segmento: 'salão de beleza' }),
      falou('Oi, Joana! Já anotei seu interesse no Studio. Alguém da equipe vai te chamar.'),
    ]);
    assert.equal(x.r.bloqueada, false);

    const { rows: [lead] } = await pool.query(
      `select l.*, e.tipo as etapa_tipo, e.fixa from crm_leads l join crm_leads_etapas e on e.id = l.etapa_id where l.tenant_id = $1 order by l.criado_em desc limit 1`,
      [C]
    );
    assert.equal(lead.empresa, 'Salão da Joana');
    assert.equal(lead.produto_interesse, 'studio');
    assert.equal(lead.segmento, 'salão de beleza');
    assert.equal(lead.etapa_tipo, 'aberta');
    assert.equal(lead.fixa, true, 'lead novo deveria nascer na etapa inicial fixa');

    const { rows: eventos } = await pool.query(`select * from crm_eventos where tenant_id = $1 and lead_id = $2`, [C, lead.id]);
    assert.equal(eventos.length, 1);
    assert.equal(eventos[0].tipo, 'agente_lead');
  });

  test('abrir_chamado cria o chamado com status aberto e registra o evento com chamado_id', opts, async () => {
    const x = await rodar(C, [{ texto: 'O CRM não está deixando eu mover o pedido de etapa, dá um erro estranho' }], [
      toolUse('buscar_ou_criar_cliente', { nome: 'Pedro' }),
      toolUse('abrir_chamado', { categoria: 'bug', descricao: 'Erro ao mover pedido de etapa no CRM', produto_afetado: 'crm', urgencia: 'alta' }),
      falou('Anotei aqui! A equipe técnica vai olhar e volta com você em breve.'),
    ]);
    assert.equal(x.r.bloqueada, false);

    const { rows: [chamado] } = await pool.query('select * from crm_chamados where tenant_id = $1 order by criado_em desc limit 1', [C]);
    assert.equal(chamado.categoria, 'bug');
    assert.equal(chamado.produto_afetado, 'crm');
    assert.equal(chamado.urgencia, 'alta');
    assert.equal(chamado.status, 'aberto');

    const { rows: eventos } = await pool.query('select * from crm_eventos where tenant_id = $1 and chamado_id = $2', [C, chamado.id]);
    assert.equal(eventos.length, 1);
    assert.equal(eventos[0].tipo, 'agente_chamado');
  });

  test('transferir_para_equipe grava handoff com MOTIVOS_KYVVO (não os motivos do Basic3D)', opts, async () => {
    const x = await rodar(C, [{ texto: 'quero falar com uma pessoa' }], [
      toolUse('buscar_ou_criar_cliente', {}),
      toolUse('transferir_para_equipe', { motivo: 'quer_falar_com_humano', resumo: 'Pediu pra falar com alguém.' }),
      falou('Vou te passar pra equipe continuar por aqui mesmo.'),
    ]);
    assert.equal(x.r.bloqueada, false);
    const { rows: [h] } = await pool.query('select * from crm_handoffs where tenant_id = $1 order by criado_em desc limit 1', [C]);
    assert.equal(h.motivo, 'quer_falar_com_humano');
  });
});
