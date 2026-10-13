-- Pedido rascunho (criado pelo agente) e campos customizados também para pedido.

-- Rascunho: pedido ainda não revisado pela equipe. O ID Shopee informado pela
-- cliente usa origem + identificador_externo (mesma chave da importação do
-- UpSeller), então a importação enriquece o pedido em vez de duplicá-lo.
alter table crm_pedidos
  add column rascunho boolean not null default false,
  add column aguardando_conferencia boolean not null default false;

-- Campos customizados passam a ter entidade (cliente | pedido). A chave única
-- vira (tenant, entidade, chave).
alter table crm_campos_customizados
  add column entidade text not null default 'cliente' check (entidade in ('cliente', 'pedido'));
alter table crm_campos_customizados drop constraint crm_campos_customizados_tenant_id_chave_key;
alter table crm_campos_customizados add constraint crm_campos_customizados_uniq unique (tenant_id, entidade, chave);

create table crm_pedidos_valores (
  pedido_id uuid not null references crm_pedidos(id) on delete cascade,
  campo_id uuid not null references crm_campos_customizados(id) on delete cascade,
  valor text,
  primary key (pedido_id, campo_id)
);
