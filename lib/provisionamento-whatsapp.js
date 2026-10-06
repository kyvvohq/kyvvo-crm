// Onboarding de WhatsApp (pedido do Bruno 2026-10-06): "ao cliente acessar o
// WABA dele de acordo com o produto já cadastramos flow e os modelos de
// mensagens" — modelos vêm do catálogo centralizado no admin (kyvvo-admin >
// WhatsApp > Catálogo de disparos), flow = as automações já existentes
// (lib/automacoes.js). Chamado best-effort por POST /crm/api/whatsapp/conectar,
// nunca bloqueia nem derruba essa rota.
const { criarTemplate } = require('@kyvvohq/whatsapp');
const { GATILHOS_VALIDOS } = require('./automacoes');

// Gatilhos que dependem de uma etapa específica do tenant (crm_etapas) não
// têm como ser auto-provisionados a partir de um catálogo genérico — o
// template ainda é criado e submetido pra aprovação da Meta (fica disponível
// pro dropdown de "Configurações > Automações" assim que aprovado), só a
// LINHA de automação em si (que exige etapa_id) continua manual.
const GATILHOS_SEM_ETAPA = ['pedido_criado', 'aniversario_cliente'];

async function buscarCatalogo() {
  const url = process.env.ADMIN_INTERNAL_URL;
  const token = process.env.ADMIN_INTERNAL_TOKEN;
  if (!url || !token) return [];
  try {
    const res = await fetch(`${url}/admin-interno/whatsapp/disparos-catalogo?produto=crm`, {
      headers: { 'x-admin-internal-token': token },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const dados = await res.json();
    return Array.isArray(dados.disparos) ? dados.disparos : [];
  } catch (err) {
    console.error(`[provisionamento-whatsapp] falha ao buscar catálogo do admin: ${err.message}`);
    return [];
  }
}

async function garantirAutomacao(pool, tenantId, disparo) {
  const { rows } = await pool.query(
    'select 1 from crm_automacoes where tenant_id = $1 and whatsapp_template = $2 limit 1',
    [tenantId, disparo.nome]
  );
  if (rows.length) return;
  await pool.query(
    `insert into crm_automacoes (tenant_id, nome, gatilho, whatsapp_template, corpo)
     values ($1, $2, $3, $4, $5)`,
    [tenantId, disparo.nome, disparo.gatilho, disparo.nome, disparo.corpo]
  );
}

// Chamado depois que o tenant conecta a própria WABA — submete pra Meta cada
// disparo padrão cadastrado no catálogo do admin e, pros gatilhos que não
// dependem de etapa, já deixa a automação pronta pra disparar assim que a
// Meta aprovar o template.
async function provisionarWhatsapp(pool, { tenantId, wabaId }) {
  const catalogo = await buscarCatalogo();
  for (const disparo of catalogo) {
    if (!GATILHOS_VALIDOS.includes(disparo.gatilho)) continue;
    try {
      const resultado = await criarTemplate({
        wabaId, nome: disparo.nome, categoria: disparo.categoria, corpo: disparo.corpo,
      });
      if (!resultado.ok) {
        console.error(`[provisionamento-whatsapp] template "${disparo.nome}" não foi criado pro tenant ${tenantId}: ${resultado.erro}`);
        continue;
      }
      if (GATILHOS_SEM_ETAPA.includes(disparo.gatilho)) {
        await garantirAutomacao(pool, tenantId, disparo);
      }
    } catch (err) {
      console.error(`[provisionamento-whatsapp] falha ao provisionar "${disparo.nome}" pro tenant ${tenantId}: ${err.message}`);
    }
  }
}

module.exports = { provisionarWhatsapp };
