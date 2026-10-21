// Créditos de WhatsApp das automações (pedido do Bruno, 2026-10-21). 1
// crédito = 1 mensagem de template enviada com sucesso por uma automação
// (lib/automacoes.js#enviarAutomacao). Dois saldos por tenant:
//   saldo_plano    — cota mensal incluída no plano contratado, "usar ou
//                    perder": reseta pro valor cheio todo mês (calendário,
//                    não a data de assinatura — mais simples, sem depender
//                    de nextDueDate do Asaas).
//   saldo_comprado — pacotes avulsos (Automações > Comprar créditos),
//                    nunca expira.
// debitar() consome a cota do plano primeiro (ela expira de qualquer jeito),
// só cai no comprado quando a cota zerar.
const PLATFORM_URL = process.env.PLATFORM_URL || 'http://platform:3003';

// Cota mensal por plano — provisória (Bruno ajusta quando fechar o valor
// real, mesmo espírito dos preços placeholder em
// kyvvo-platform/db/009_crm_planos.sql). Um só lugar no código pra trocar.
const COTA_MENSAL_POR_PLANO = {
  crm_start: 100,
  crm_professional: 300,
  crm_business: 800,
};

// Mesmo padrão de chamada servidor-a-servidor já usado em index.js
// (chamarPlatformInterno) — aqui só precisa do campo `plano`, então fica um
// helper próprio em vez de importar o closure de index.js.
async function buscarPlanoTenant(tenantId) {
  try {
    const res = await fetch(`${PLATFORM_URL}/internal/pagamentos-crm/${tenantId}`, {
      headers: { 'X-Internal-Token': process.env.PLATFORM_PAGAMENTOS_TOKEN },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const dados = await res.json();
    return dados.plano || null;
  } catch (erro) {
    console.error(`[creditos] falha ao buscar plano do tenant ${tenantId}: ${erro.message}`);
    return null;
  }
}

function inicioDoMesAtualUtc() {
  const agora = new Date();
  return new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1));
}

// Chamado antes de ler ou debitar o saldo — nunca depende só do timing de um
// checador periódico. Idempotente: se já renovou neste mês, não faz nada.
async function garantirRenovacaoMensal(pool, tenantId) {
  const { rows } = await pool.query('select ciclo_renovado_em from crm_creditos where tenant_id = $1', [tenantId]);
  const atual = rows[0];
  const inicioMes = inicioDoMesAtualUtc();
  if (atual && atual.ciclo_renovado_em && new Date(atual.ciclo_renovado_em) >= inicioMes) return;

  const plano = await buscarPlanoTenant(tenantId);
  const cota = COTA_MENSAL_POR_PLANO[plano] || 0;
  await pool.query(
    `insert into crm_creditos (tenant_id, saldo_plano, saldo_comprado, ciclo_renovado_em)
     values ($1, $2, 0, now())
     on conflict (tenant_id) do update set saldo_plano = $2, ciclo_renovado_em = now()`,
    [tenantId, cota]
  );
}

async function obterSaldo(pool, tenantId) {
  await garantirRenovacaoMensal(pool, tenantId);
  const { rows } = await pool.query('select saldo_plano, saldo_comprado from crm_creditos where tenant_id = $1', [tenantId]);
  const linha = rows[0] || { saldo_plano: 0, saldo_comprado: 0 };
  return { saldoPlano: linha.saldo_plano, saldoComprado: linha.saldo_comprado, saldoTotal: linha.saldo_plano + linha.saldo_comprado };
}

// Atômico: só debita se houver saldo (plano OU comprado); devolve false sem
// mudar nada quando não há. Consome o saldo_plano primeiro.
async function debitar(pool, tenantId) {
  await garantirRenovacaoMensal(pool, tenantId);
  const { rows } = await pool.query(
    `update crm_creditos set
       saldo_plano = case when saldo_plano > 0 then saldo_plano - 1 else saldo_plano end,
       saldo_comprado = case when saldo_plano > 0 then saldo_comprado else saldo_comprado - 1 end,
       atualizado_em = now()
     where tenant_id = $1 and (saldo_plano > 0 or saldo_comprado > 0)
     returning saldo_plano, saldo_comprado`,
    [tenantId]
  );
  return rows.length > 0;
}

// Chamado pelo kyvvo-platform quando um pagamento de créditos avulsos
// confirma (ver POST /crm/plataforma-interno/creditos/confirmar). Nunca
// expira — soma direto no comprado, sem passar pela renovação mensal. Não
// toca ciclo_renovado_em: se o tenant nunca teve a cota do plano aplicada
// ainda (comprou crédito antes de qualquer disparo), a renovação mensal
// continua pendente e roda normalmente na próxima leitura/débito.
async function creditarCompra(pool, tenantId, quantidade) {
  const { rows } = await pool.query(
    `insert into crm_creditos (tenant_id, saldo_comprado)
     values ($1, $2)
     on conflict (tenant_id) do update set saldo_comprado = crm_creditos.saldo_comprado + $2, atualizado_em = now()
     returning saldo_plano, saldo_comprado`,
    [tenantId, quantidade]
  );
  return rows[0];
}

module.exports = { obterSaldo, debitar, creditarCompra, garantirRenovacaoMensal, COTA_MENSAL_POR_PLANO };
