-- Segmento e Origem do cliente viram combobox (pedido do Bruno, 2026-09-25)
-- em vez de texto livre — o CRUD das opções fica em Configurações > Cadastro.
-- Uma tabela genérica pros dois em vez de duas tabelas iguais (mesmo shape:
-- lista de valores por tenant, com ativo/inativo).
create table crm_opcoes_cadastro (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  tipo text not null check (tipo in ('segmento', 'origem')),
  valor text not null,
  ativo boolean not null default true,
  criado_em timestamptz not null default now()
);
create unique index crm_opcoes_cadastro_tenant_tipo_valor_uniq on crm_opcoes_cadastro (tenant_id, tipo, lower(valor));
