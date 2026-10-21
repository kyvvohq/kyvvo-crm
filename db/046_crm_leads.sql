-- Funil de vendas pra tenants que trackeiam oportunidades fora do modelo de
-- pedido/encomenda (ex.: o próprio Kyvvo como tenant do seu CRM — bot de
-- atendimento geral/suporte/vendas). Tabela separada de crm_etapas/
-- crm_pedidos de propósito: crm_etapas é consultada sem filtro de "tipo" em
-- ~20 pontos espalhados pelo código (index.js + vários lib/*.js) — tornar
-- essa tabela polimórfica exigiria auditar e corrigir todos esses pontos
-- pra não vazar/misturar linhas de funis diferentes. Não vale o risco pra
-- uma feature nova e isolada.
create table crm_leads_etapas (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  nome text not null,
  ordem int not null,
  tipo text not null check (tipo in ('aberta', 'ganha', 'perdida')),
  fixa boolean not null default false,  -- etapa inicial, onde o agente cria o lead
  criado_em timestamptz not null default now(),
  unique (tenant_id, nome)
);
create index crm_leads_etapas_tenant_ordem_idx on crm_leads_etapas (tenant_id, ordem);

create table crm_leads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  cliente_id uuid not null references crm_clientes(id) on delete restrict,
  etapa_id uuid not null references crm_leads_etapas(id) on delete restrict,
  origem text not null default 'WhatsApp',
  origem_conversa_id uuid references crm_conversas_whatsapp(id) on delete set null,
  valor_estimado numeric(10,2),
  motivo_perda text,
  observacoes text,
  -- Campos do lead (hoje fixos em coluna, não via crm_campos_customizados:
  -- são definidos pela própria ferramenta do agente da Kyvvo, não variam
  -- por tenant neste v1 — ver lib/agente/ferramentas-kyvvo.js).
  empresa text,
  produto_interesse text,
  segmento text,
  porte text check (porte in ('pequeno', 'medio', 'grande')),
  plano_interesse text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index crm_leads_tenant_etapa_idx on crm_leads (tenant_id, etapa_id);
create index crm_leads_tenant_cliente_idx on crm_leads (tenant_id, cliente_id);
create index crm_leads_tenant_idx on crm_leads (tenant_id);
