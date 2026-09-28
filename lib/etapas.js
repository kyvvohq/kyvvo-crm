// Modelo de segmento único do MVP: "Produção sob encomenda", a configuração
// da Basic 3D Print virando o modelo padrão (seção 5 do doc). Etapas são
// configuráveis por conta (seção 5) — isto é só o ponto de partida sugerido
// no onboarding, nunca hardcoded no restante do produto.
const ETAPAS_PADRAO_PRODUCAO_SOB_ENCOMENDA = [
  { nome: 'A fazer', tipo: 'aberta', prazo_alerta_dias: 2, eh_pronto: false, fixa: true },
  { nome: 'Orçamento enviado', tipo: 'aberta', prazo_alerta_dias: 3, eh_pronto: false },
  { nome: 'Aprovado', tipo: 'aberta', prazo_alerta_dias: null, eh_pronto: false },
  { nome: 'Produção', tipo: 'aberta', prazo_alerta_dias: 5, eh_pronto: false },
  { nome: 'Pronto', tipo: 'aberta', prazo_alerta_dias: 2, eh_pronto: true },
  { nome: 'Enviado/Entregue', tipo: 'ganha', prazo_alerta_dias: null, eh_pronto: false },
  { nome: 'Perdido', tipo: 'perdida', prazo_alerta_dias: null, eh_pronto: false },
];

// Chamado uma vez por tenant (idempotente: não faz nada se já existem
// etapas). Ver index.js — disparado no primeiro acesso autenticado.
async function inicializarEtapasPadrao(pool, tenantId) {
  const { rows } = await pool.query('select 1 from crm_etapas where tenant_id = $1 limit 1', [tenantId]);
  if (rows.length > 0) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < ETAPAS_PADRAO_PRODUCAO_SOB_ENCOMENDA.length; i++) {
      const etapa = ETAPAS_PADRAO_PRODUCAO_SOB_ENCOMENDA[i];
      await client.query(
        `insert into crm_etapas (tenant_id, nome, ordem, tipo, prazo_alerta_dias, eh_pronto, fixa) values ($1, $2, $3, $4, $5, $6, $7)`,
        [tenantId, etapa.nome, i, etapa.tipo, etapa.prazo_alerta_dias, etapa.eh_pronto, !!etapa.fixa]
      );
    }
    await client.query('COMMIT');
  } catch (erro) {
    await client.query('ROLLBACK');
    throw erro;
  } finally {
    client.release();
  }
}

// US28: flag explícito (crm_etapas.eh_pronto) em vez da heurística antiga por
// posição. Fallback pra heurística cobre contas criadas antes da migration
// 003 que ainda não marcaram nenhuma etapa manualmente.
async function buscarEtapaPronto(pool, tenantId) {
  const { rows: marcada } = await pool.query(
    'select id from crm_etapas where tenant_id = $1 and eh_pronto = true limit 1',
    [tenantId]
  );
  if (marcada[0]) return marcada[0].id;

  const { rows } = await pool.query(
    `select id from crm_etapas
     where tenant_id = $1 and tipo = 'aberta'
       and ordem < (select min(ordem) from crm_etapas where tenant_id = $1 and tipo = 'ganha')
     order by ordem desc limit 1`,
    [tenantId]
  );
  return rows[0] ? rows[0].id : null;
}

module.exports = { ETAPAS_PADRAO_PRODUCAO_SOB_ENCOMENDA, inicializarEtapasPadrao, buscarEtapaPronto };
