-- Corrige retroativamente os pedidos já importados (NF-e/UpSeller) que
-- ficaram com valor_recebido=0/status_pagamento='pendente' (bug real,
-- 2026-10-03 — lib/importacoes.js nunca setava esses dois campos na
-- importação, só valor_total). Sem isso, toda venda importada aparecia
-- como "pagamento pendente" pra sempre e não contava em "total gasto"/
-- "ticket médio" do cliente, mesmo já sendo uma venda concluída e
-- faturada no passado. Só pedidos com origem = importação — não mexe em
-- pedido criado pelo Kanban/bot, onde "ganha" e "totalmente pago" são
-- estados de verdade distintos.
update crm_pedidos
set valor_recebido = valor_total, status_pagamento = 'pago'
where origem in ('nfe', 'upseller') and status_pagamento != 'pago';
