-- Primeira coluna do Quadro fica fixa à esquerda (pedido do Bruno): todo
-- pedido novo entra sempre nela, ela nunca sai do lugar no drag-and-drop de
-- colunas, e sair dela exige cliente vinculado (ver PATCH
-- /crm/api/pedidos/:id/etapa). `fixa` substitui "menor ordem entre
-- tipo='aberta'" como critério de "etapa de entrada" — mais robusto, porque
-- ordem muda quando o dono reordena as colunas, fixa não.
alter table crm_etapas add column fixa boolean not null default false;

-- Backfill: promove a etapa 'aberta' de menor ordem de cada tenant existente
-- a fixa=true, renomeada pra "A fazer" (nome pedido pelo Bruno). Tenant sem
-- nenhuma etapa 'aberta' (não devia acontecer — todo tenant tem
-- inicializarEtapasPadrao rodado no onboarding) simplesmente não ganha
-- nenhuma etapa fixa; POST /crm/api/pedidos trata esse caso à parte.
update crm_etapas set fixa = true, nome = 'A fazer'
where id in (
  select distinct on (tenant_id) id
  from crm_etapas
  where tipo = 'aberta'
  order by tenant_id, ordem asc
);
