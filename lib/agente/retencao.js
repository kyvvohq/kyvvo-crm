// Retenção de logs do agente (LGPD — a Kyvvo é operadora; o prazo é decisão da conta, controlador).
// `crm_agente_config.retencao_logs_dias` = null → não apaga nada (padrão até a conta definir).
// O que é expurgado: execuções do agente (crm_agente_execucoes: texto proposto, texto original bloqueado,
// ferramentas e entradas). O que NÃO é: mensagens, pedidos, eventos e anexos — são registro do relacionamento
// com a cliente e seguem a retenção do cadastro dela (ver docs/agente/lgpd.md).
async function expurgarLogs(pool) {
  const { rows: contas } = await pool.query('select tenant_id, retencao_logs_dias from crm_agente_config where retencao_logs_dias is not null and retencao_logs_dias > 0');
  const resultado = [];
  for (const c of contas) {
    const { rowCount } = await pool.query(
      "delete from crm_agente_execucoes where tenant_id = $1 and criado_em < now() - make_interval(days => $2)", [c.tenant_id, c.retencao_logs_dias]);
    if (rowCount) resultado.push({ tenant_id: c.tenant_id, execucoes_apagadas: rowCount });
  }
  return resultado;
}

module.exports = { expurgarLogs };
