-- "Confirmar frete" no menu ⋯ do Quadro — frete pode ser avulso/variável
-- (ex.: entrega por Uber, valor só confirmado perto da entrega, pago direto
-- ao entregador) — precisa de um controle separado de "pago ou não",
-- igual já existe pra status_pagamento, mas sem acoplar aos dois (um pedido
-- pode estar com o produto pago e o frete ainda pendente, ou vice-versa).
alter table crm_pedidos add column frete_pago boolean not null default false;
