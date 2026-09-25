-- Motor de automação por gatilho (issue #40, pedido do Bruno 2026-09-25) —
-- espelha o conceito de kyvvo-people/lib/automacoes.js, bem mais enxuto:
-- só canal WhatsApp (CRM não manda e-mail), sem trava de limite de plano
-- (o CRM ainda não tem catálogo de planos) e V1 só funciona pra tenant com
-- número vinculado em crm_whatsapp_numeros (hoje só a Basic) — o Bruno já
-- confirmou que essa limitação é aceitável por enquanto.
--
-- "pedido_parado" reaproveita crm_etapas.prazo_alerta_dias (já existe, já
-- alimenta o card "orçamentos parados" do Painel Hoje) como o número de
-- dias — não duplica esse conceito numa coluna nova.
create table crm_automacoes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  nome text not null,
  gatilho text not null check (gatilho in ('mudanca_etapa', 'pedido_criado', 'pedido_parado', 'aniversario_cliente')),
  etapa_id uuid references crm_etapas(id) on delete cascade,
  whatsapp_template text,
  ativo boolean not null default true,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index crm_automacoes_gatilho_idx on crm_automacoes (tenant_id, gatilho) where ativo = true;

-- Trava de 24h (não manda WhatsApp de automação mais de uma vez por dia pro
-- mesmo número, mesmo padrão de kyvvo-people.whatsapp_envios) e histórico
-- de disparos (pra debug/auditoria — sem UI de listagem nesta v1).
-- `pedido_id` é só metadado (nulo pra gatilhos sem pedido, como aniversário)
-- usado pra desduplicar "pedido_parado": não reenviar enquanto o pedido não
-- sair e voltar pra mesma etapa (ver lib/automacoes.js).
create table crm_whatsapp_envios (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  telefone_e164 text not null,
  enviado_em timestamptz not null default now()
);
create index crm_whatsapp_envios_telefone_idx on crm_whatsapp_envios (telefone_e164, enviado_em);

create table crm_whatsapp_disparos (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  telefone_e164 text not null,
  template_nome text,
  gatilho text,
  status text not null,
  mensagem_texto text,
  pedido_id uuid,
  criado_em timestamptz not null default now()
);
create index crm_whatsapp_disparos_pedido_idx on crm_whatsapp_disparos (pedido_id, gatilho, criado_em);
