-- Janela de encerramento + retomada de atendimento (Configurações >
-- Preferências, pedido do Bruno). Substitui bot_retomada_horas (sem teto,
-- guardava em HORAS, usado só pelo checador silencioso de 24h em 24h) por
-- bot_janela_encerramento_minutos (teto de 8h = 480min, piso de 15min) —
-- mudança de comportamento assumida (default cai de 24h pra 2h); dado
-- existente é convertido e limitado ao novo teto, nunca perdido.
alter table crm_configuracoes add column bot_janela_encerramento_minutos smallint;
update crm_configuracoes set bot_janela_encerramento_minutos = least(coalesce(bot_retomada_horas, 24) * 60, 480);
alter table crm_configuracoes alter column bot_janela_encerramento_minutos set not null;
alter table crm_configuracoes alter column bot_janela_encerramento_minutos set default 120;
alter table crm_configuracoes add constraint crm_configuracoes_janela_encerramento_minutos_check
  check (bot_janela_encerramento_minutos between 15 and 480);
alter table crm_configuracoes drop column bot_retomada_horas;

-- Retomada (nudge proativo) — desligada por padrão, só liga quem configurar.
alter table crm_configuracoes add column bot_retomada_ativa boolean not null default false;
alter table crm_configuracoes add column bot_retomada_tentativas smallint not null default 1
  check (bot_retomada_tentativas between 1 and 3);
alter table crm_configuracoes add column bot_retomada_intervalo_horas smallint not null default 1
  check (bot_retomada_intervalo_horas between 1 and 3);

-- Controle de nudge por conversa — zerado toda vez que salvarConversa() roda
-- (atividade real do cliente), incrementado só pelo worker de retomada.
alter table crm_conversas_whatsapp add column retomada_tentativas smallint not null default 0;
alter table crm_conversas_whatsapp add column retomada_ultima_em timestamptz;
