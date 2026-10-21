-- Chamado (suporte): workflow de status simples, não um funil configurável
-- como Lead — não há "etapas" por conta neste primeiro marco, só um status
-- fixo de ticket.
create table crm_chamados (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  cliente_id uuid not null references crm_clientes(id) on delete restrict,
  origem text not null default 'WhatsApp',
  origem_conversa_id uuid references crm_conversas_whatsapp(id) on delete set null,
  categoria text,                 -- 'bug' | 'duvida_tecnica' | 'reclamacao' | 'outro' (refinável por conta via crm_campos_customizados)
  descricao text not null,
  produto_afetado text,
  urgencia text not null default 'media' check (urgencia in ('baixa', 'media', 'alta', 'critica')),
  status text not null default 'aberto' check (status in ('aberto', 'em_andamento', 'aguardando_cliente', 'resolvido', 'fechado')),
  resolucao_resumo text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  resolvido_em timestamptz
);
create index crm_chamados_tenant_status_idx on crm_chamados (tenant_id, status);
create index crm_chamados_tenant_cliente_idx on crm_chamados (tenant_id, cliente_id);
