-- Companheira do fix de @kyvvohq/agente-core 0.1.2 (reseta o limite de
-- turnos quando a equipe devolve a conversa pro agente). Default = criado_em
-- pra conversas já existentes não ficarem com a coluna nula (o executor usa
-- `conversa.turnos_contados_desde || conversa.criado_em` como fallback, mas
-- preencher aqui evita depender só do fallback em runtime).
alter table crm_conversas_whatsapp add column turnos_contados_desde timestamptz;
update crm_conversas_whatsapp set turnos_contados_desde = criado_em where turnos_contados_desde is null;
alter table crm_conversas_whatsapp alter column turnos_contados_desde set default now();
