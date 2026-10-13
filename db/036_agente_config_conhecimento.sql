-- Configuração do agente por conta e base de conhecimento versionada.
-- Nada da Basic vive em código: horário, categorias com quantidade padrão,
-- textos e limites são linhas daqui (seed em db/seeds/basic.json).
create table crm_agente_config (
  tenant_id uuid primary key,
  modo text not null default 'desligado' check (modo in ('desligado', 'rascunho', 'automatico')),
  modelo_runtime text not null default 'claude-haiku-4-5',
  -- {"inicio":"08:00","fim":"18:00","fuso":"America/Sao_Paulo","dias":null}
  -- dias null = todos os dias (a definir com a conta, ver pendências).
  horario_atendimento jsonb not null default '{"inicio":"08:00","fim":"18:00","fuso":"America/Sao_Paulo","dias":null}',
  mensagem_fora_horario text,
  -- {"categorias":[{"nome":"Cortador","quantidade_padrao":1}]}
  regras_categoria jsonb not null default '{"categorias":[]}',
  -- {"max_turnos":20,"max_mensagens_conversa":40,"teto_diario_tokens":null}
  limites jsonb not null default '{}',
  flags jsonb not null default '{"status_automatico":false}',
  retencao_logs_dias integer,                -- null = sem expurgo automático (LGPD: definir por conta)
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

create table crm_agente_conhecimento (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  tipo text not null check (tipo in ('voz', 'regras', 'fluxo', 'casos', 'respostas')),
  conteudo_md text not null,
  versao integer not null default 1,
  ativo boolean not null default true,
  criado_em timestamptz not null default now(),
  unique (tenant_id, tipo, versao)
);
-- no máximo uma versão ativa por tipo
create unique index crm_agente_conhecimento_ativo_uniq
  on crm_agente_conhecimento (tenant_id, tipo) where ativo;
