-- "Fechar" o aviso de canal próprio (cartão de recompra) é por pedido e
-- permanente — não reaparece depois de fechado, mesmo reabrindo o modal.
alter table crm_pedidos add column aviso_canal_proprio_fechado boolean not null default false;
