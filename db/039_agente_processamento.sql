-- Processamento assíncrono do agente. Sem tabela de fila: a própria mensagem
-- recebida é o item da fila (processada_em nulo = ainda falta o agente olhar).
-- O webhook grava a mensagem e responde 200; o processamento roda em seguida e
-- uma varredura periódica reprocessa o que ficou para trás (queda do processo).
alter table crm_mensagens_whatsapp
  add column processada_em timestamptz,
  add column tentativas integer not null default 0,
  add column midia jsonb;                    -- {mediaId, nomeArquivo, mime} até o download virar anexo
create index crm_mensagens_whatsapp_pendentes_idx
  on crm_mensagens_whatsapp (criado_em)
  where autor = 'cliente' and processada_em is null;

-- Nome de perfil que a Meta manda junto da mensagem (usado se a cliente ainda
-- não tem cadastro).
alter table crm_conversas_whatsapp
  add column nome_whatsapp text;
