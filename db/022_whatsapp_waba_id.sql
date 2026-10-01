-- Self-service de conexão do WhatsApp (Embedded Signup da Meta) pro CRM —
-- mesmo fluxo que o kyvvo-studio já tem, adaptado pro modelo multi-número
-- do CRM (crm_whatsapp_numeros, não uma coluna direto em tenants). Precisa
-- do waba_id salvo (não só o phone_number_id) pra poder gerenciar/depurar a
-- conexão depois (ex.: Admin > WhatsApp > WABAs já lista isso pros outros
-- produtos).
alter table crm_whatsapp_numeros add column meta_waba_id text;
