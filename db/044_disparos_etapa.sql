-- Nome da etapa no momento do disparo (gatilhos mudanca_etapa/pedido_parado),
-- só pra exibir em Automações > Consumo e histórico ("+ Etapa" no gatilho) —
-- não é FK pra crm_etapas de propósito: a etapa pode ser renomeada ou
-- excluída depois, e o histórico deve continuar mostrando o nome de quando
-- o disparo aconteceu (pedido do Bruno, 2026-10-21).
alter table crm_whatsapp_disparos add column if not exists etapa_nome text;
