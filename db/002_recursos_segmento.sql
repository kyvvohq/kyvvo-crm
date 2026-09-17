-- Pedido do Bruno (2026-09-17): quadro de pedidos editável (etapas
-- CRUD + reordenação, como o quadro do kyvvo-people) e "raias" —
-- recursos de produção (ex: impressoras 3D) pra acompanhar fila/tempo
-- por recurso. Também: segmento do cliente (que tipo de negócio ele é
-- — confeitaria, loja de joias etc., configurável por conta).

alter table crm_clientes add column if not exists segmento text;

-- Recursos de produção — configurável por conta, nunca hardcoded (seção 5
-- do doc). Pedido sem recurso atribuído cai na raia fixa "Sem recurso" no
-- kanban (recurso_id null), por isso o FK é opcional e ON DELETE SET NULL:
-- apagar um recurso não apaga nem trava os pedidos que estavam nele.
create table crm_recursos (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  nome text not null,
  ordem int not null default 0,
  ativo boolean not null default true,
  criado_em timestamptz not null default now()
);

create index crm_recursos_tenant_idx on crm_recursos (tenant_id) where ativo;

alter table crm_pedidos add column if not exists recurso_id uuid references crm_recursos(id) on delete set null;
create index crm_pedidos_recurso_idx on crm_pedidos (recurso_id) where recurso_id is not null;
