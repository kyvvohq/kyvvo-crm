-- Novo submenu Configurações > Geral (pedido do Bruno, 2026-10-03): 3
-- parâmetros que antes eram fixos no código ou nem existiam —
-- horario_atendimento_* substitui o Seg-Sex 8h-18h hardcoded em
-- lib/bot-whatsapp.js (dias úteis continuam fixos, só o pedido explícito era
-- o horário); bot_retomada_horas é novo — "retoma" (reinicia) uma conversa
-- do bot parada há mais tempo que isso sem o cliente avançar;
-- quadro_dias_ultima_coluna também é novo — depois de quantos dias um
-- pedido concluído (última coluna, maior "ordem" de crm_etapas) some da
-- visão do Quadro (continua existindo e visível normalmente em Pedidos).
alter table crm_configuracoes add column horario_atendimento_inicio smallint not null default 8;
alter table crm_configuracoes add column horario_atendimento_fim smallint not null default 18;
alter table crm_configuracoes add column bot_retomada_horas smallint not null default 24;
alter table crm_configuracoes add column quadro_dias_ultima_coluna smallint not null default 30;
