-- Mensagem de aviso no modal de pedido (hoje fixa no código, "📦 Pedido de
-- canal próprio...") vira editável + com liga/desliga em Configurações >
-- Geral. Default = o texto que já estava hardcoded, pra não mudar nada do
-- que já existe até alguém editar.
alter table crm_configuracoes add column mensagem_aviso_pedido text not null
  default '📦 Pedido de canal próprio — não esqueça o cartão de recompra no kit.';
alter table crm_configuracoes add column mensagem_aviso_pedido_ativo boolean not null default true;
