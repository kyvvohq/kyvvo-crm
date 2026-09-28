-- Configurações por tenant que não cabem em nenhuma tabela de domínio já
-- existente (CRM não tem uma tabela `tenants` própria — identidade de tenant
-- é global via kyvvo-platform). Primeiro uso: notificacoes_ativas, mesmo
-- molde do kyvvo-studio (tenants.notificacoes_ativas) — formato
-- {"<chave>": {"ativo": bool, ...params}}.
create table crm_configuracoes (
  tenant_id uuid primary key,
  notificacoes_ativas jsonb not null default '{}',
  atualizado_em timestamptz not null default now()
);
