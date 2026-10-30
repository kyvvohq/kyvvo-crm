-- Companheira do fix de @kyvvohq/agente-core 0.1.4: ao reabrir uma conversa
-- "encerrada" (mensagem nova do cliente vira situacao 'bot' automaticamente,
-- ver recebimento.js), o histórico mandado pro modelo não deve incluir nada
-- de ANTES do encerramento -- senão o atendimento anterior (já resolvido
-- pela equipe) volta a pesar no contexto e pode levar o agente a escalar de
-- novo, repetindo a mensagem de encaminhamento pra cliente minutos depois
-- de alguém ter fechado o caso manualmente (achado em produção, Basic 3D
-- Print, 2026-10-29). NULL = nunca foi encerrada, sem corte de histórico.
alter table crm_conversas_whatsapp add column encerrada_em timestamptz;
