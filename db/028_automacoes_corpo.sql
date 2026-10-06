-- Onboarding de WhatsApp (pedido do Bruno 2026-10-06): ao conectar a própria
-- WABA, o tenant recebe automaticamente os disparos padrão cadastrados no
-- catálogo do admin (kyvvo-admin > WhatsApp > Catálogo de disparos) — ver
-- lib/provisionamento-whatsapp.js. Faltava onde guardar o corpo do texto
-- (Studio já tem isso desde a 068_automacoes.sql; CRM não tinha).
alter table crm_automacoes add column corpo text;
