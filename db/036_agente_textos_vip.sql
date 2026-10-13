-- Textos fixos e regra de VIP por conta (nada disso mora em código), e o tipo
-- "sistema" na base de conhecimento (camada fixa do prompt de sistema).
alter table crm_agente_config
  -- tag do CRM que marca cliente VIP e o desconto que a equipe aplica no orçamento
  add column vip jsonb not null default '{"tag":"VIP","desconto_percentual":10}',
  -- {"encaminhamento": "...", "desconto_vip": "...", "somente_texto": "..."}
  add column textos jsonb not null default '{}';

alter table crm_agente_conhecimento drop constraint crm_agente_conhecimento_tipo_check;
alter table crm_agente_conhecimento
  add constraint crm_agente_conhecimento_tipo_check
  check (tipo in ('sistema', 'voz', 'regras', 'fluxo', 'casos', 'respostas'));
