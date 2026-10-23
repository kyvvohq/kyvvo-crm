-- Canal "Push" (notificação do navegador) — réplica do kyvvo-studio
-- (096_push_subscriptions.sql). Sem FK pra tenant_id/usuario_id: o CRM não
-- tem tabela `tenants`/`usuarios` própria, identidade é global via
-- kyvvo-platform (ver lib/notificacoes.js, mesmo raciocínio de
-- crm_notificacoes_eventos).
create table crm_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  usuario_id uuid not null,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  criado_em timestamptz not null default now()
);
create index idx_crm_push_subscriptions_tenant on crm_push_subscriptions (tenant_id);
