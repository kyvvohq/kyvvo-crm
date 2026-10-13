// Seed idempotente do agente por conta. Os dados vêm de um JSON (ex.:
// db/seeds/basic.json) — nada específico de uma conta mora em código.
// Rodar de novo com o mesmo arquivo converge para o mesmo estado.

async function semearAgente(pool, tenantId, seed, { modo = 'desligado', phoneNumberId = null, numeroExibido = null, canalModo = 'api', conhecimento = null } = {}) {
  if (!tenantId) throw new Error('tenantId obrigatório');
  const c = seed.config || {};

  await pool.query(
    `insert into crm_agente_config
       (tenant_id, modo, modelo_runtime, horario_atendimento, mensagem_fora_horario, regras_categoria, limites, flags, vip, textos)
     values ($1, $2, coalesce($3, 'claude-haiku-4-5'),
       coalesce($4::jsonb, '{"inicio":"08:00","fim":"18:00","fuso":"America/Sao_Paulo","dias":null}'::jsonb),
       $5, coalesce($6::jsonb, '{"categorias":[]}'::jsonb), coalesce($7::jsonb, '{}'::jsonb),
       coalesce($8::jsonb, '{"status_automatico":false}'::jsonb),
       coalesce($9::jsonb, '{"tag":"VIP","desconto_percentual":10}'::jsonb), coalesce($10::jsonb, '{}'::jsonb))
     on conflict (tenant_id) do update set
       modo = excluded.modo, modelo_runtime = excluded.modelo_runtime,
       horario_atendimento = excluded.horario_atendimento, mensagem_fora_horario = excluded.mensagem_fora_horario,
       regras_categoria = excluded.regras_categoria, limites = excluded.limites, flags = excluded.flags, vip = excluded.vip, textos = excluded.textos,
       atualizado_em = now()`,
    [
      tenantId, modo, c.modelo_runtime || null,
      c.horario_atendimento ? JSON.stringify(c.horario_atendimento) : null,
      c.mensagem_fora_horario || null,
      c.regras_categoria ? JSON.stringify(c.regras_categoria) : null,
      c.limites ? JSON.stringify(c.limites) : null,
      c.flags ? JSON.stringify(c.flags) : null,
      c.vip ? JSON.stringify(c.vip) : null,
      c.textos ? JSON.stringify(c.textos) : null,
    ],
  );

  for (const campo of seed.campos_pedido || []) {
    await pool.query(
      `insert into crm_campos_customizados (tenant_id, entidade, chave, label, tipo, opcoes, ordem)
       values ($1, 'pedido', $2, $3, $4, $5::jsonb, $6)
       on conflict (tenant_id, entidade, chave) do update set
         label = excluded.label, tipo = excluded.tipo, opcoes = excluded.opcoes, ordem = excluded.ordem`,
      [tenantId, campo.chave, campo.label, campo.tipo, campo.opcoes ? JSON.stringify(campo.opcoes) : null, campo.ordem ?? 0],
    );
  }

  // Base de conhecimento versionada: conteúdo igual ao da versão ativa = nada muda;
  // conteúdo novo vira versão nova e a anterior fica inativa (histórico preservado).
  for (const [tipo, conteudo] of Object.entries(conhecimento || {})) {
    const { rows } = await pool.query(
      'select versao, conteudo_md from crm_agente_conhecimento where tenant_id = $1 and tipo = $2 and ativo', [tenantId, tipo]);
    if (rows[0] && rows[0].conteudo_md === conteudo) continue;
    const { rows: [m] } = await pool.query(
      'select coalesce(max(versao), 0) + 1 as v from crm_agente_conhecimento where tenant_id = $1 and tipo = $2', [tenantId, tipo]);
    await pool.query('update crm_agente_conhecimento set ativo = false where tenant_id = $1 and tipo = $2 and ativo', [tenantId, tipo]);
    await pool.query(
      'insert into crm_agente_conhecimento (tenant_id, tipo, conteudo_md, versao, ativo) values ($1, $2, $3, $4, true)',
      [tenantId, tipo, conteudo, m.v]);
  }

  if (phoneNumberId) {
    // O número pertence a um único tenant: não rouba número de outra conta.
    const { rows } = await pool.query('select tenant_id from crm_whatsapp_numeros where phone_number_id = $1', [phoneNumberId]);
    if (rows[0] && rows[0].tenant_id !== tenantId) throw new Error('phone_number_id já pertence a outra conta');
    await pool.query(
      `insert into crm_whatsapp_numeros (phone_number_id, tenant_id, numero_exibido, modo)
       values ($1, $2, $3, $4)
       on conflict (phone_number_id) do update set numero_exibido = coalesce(excluded.numero_exibido, crm_whatsapp_numeros.numero_exibido), modo = excluded.modo`,
      [phoneNumberId, tenantId, numeroExibido, canalModo],
    );
  }
}

module.exports = { semearAgente };
