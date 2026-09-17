// Modelo de segmento único do MVP: "Produção sob encomenda", a configuração
// da Basic 3D Print virando o modelo padrão (seção 5 do doc). Etapas são
// configuráveis por conta (seção 5) — isto é só o ponto de partida sugerido
// no onboarding, nunca hardcoded no restante do produto.
const ETAPAS_PADRAO_PRODUCAO_SOB_ENCOMENDA = [
  { nome: 'Fazer orçamento', tipo: 'aberta', prazo_alerta_dias: 2 },
  { nome: 'Orçamento enviado', tipo: 'aberta', prazo_alerta_dias: 3 },
  { nome: 'Aprovado', tipo: 'aberta', prazo_alerta_dias: null },
  { nome: 'Produção', tipo: 'aberta', prazo_alerta_dias: 5 },
  { nome: 'Pronto', tipo: 'aberta', prazo_alerta_dias: 2 },
  { nome: 'Enviado/Entregue', tipo: 'ganha', prazo_alerta_dias: null },
  { nome: 'Perdido', tipo: 'perdida', prazo_alerta_dias: null },
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
        `insert into crm_etapas (tenant_id, nome, ordem, tipo, prazo_alerta_dias) values ($1, $2, $3, $4, $5)`,
        [tenantId, etapa.nome, i, etapa.tipo, etapa.prazo_alerta_dias]
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

// Heurística do Painel Hoje (seção 7.6) pra "pronto pra envio ou retirada":
// a última etapa tipo 'aberta' antes da primeira etapa tipo 'ganha', por
// ordem. O schema (seção 6) não tem um flag explícito de "pronto" — isto é
// uma aproximação; ver docs/DECISOES-PENDENTES.md #4.
async function buscarEtapaPronto(pool, tenantId) {
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
