-- Auditoria de cada rodada do agente e fila de encaminhamentos para a equipe.
create table crm_agente_execucoes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  conversa_id uuid not null references crm_conversas_whatsapp(id) on delete cascade,
  mensagem_entrada_id uuid references crm_mensagens_whatsapp(id) on delete set null,
  modelo text,
  ferramentas_chamadas jsonb not null default '[]',
  resposta_proposta text,
  resposta_enviada text,
  bloqueada_por_filtro boolean not null default false,
  motivo_bloqueio text,
  -- o que a pessoa fez com a sugestão (modo rascunho)
  decisao text check (decisao in ('aprovada', 'editada', 'descartada')),
  decidida_em timestamptz,
  tokens_in integer,
  tokens_out integer,
  latencia_ms integer,
  criado_em timestamptz not null default now()
);
create index crm_agente_execucoes_conversa_idx on crm_agente_execucoes (tenant_id, conversa_id, criado_em);

-- Cada encaminhamento vira item no Painel Hoje ("com quem preciso falar hoje?").
create table crm_handoffs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  conversa_id uuid not null references crm_conversas_whatsapp(id) on delete cascade,
  cliente_id uuid references crm_clientes(id) on delete set null,
  pedido_id uuid references crm_pedidos(id) on delete set null,
  motivo text not null,
  resumo text,
  dados_coletados jsonb not null default '{}',
  eh_vip boolean not null default false,
  status text not null default 'aberto' check (status in ('aberto', 'assumido', 'resolvido')),
  atribuido_a uuid,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index crm_handoffs_status_idx on crm_handoffs (tenant_id, status, criado_em);
-- um handoff aberto por conversa: novos motivos atualizam o existente
create unique index crm_handoffs_aberto_uniq on crm_handoffs (tenant_id, conversa_id) where status = 'aberto';
