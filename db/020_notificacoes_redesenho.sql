-- Redesenho de Notificações do CRM, trazendo paridade com o kyvvo-studio:
-- matriz de canais (E-mail/WhatsApp/CRM) com envio real, tipos orientados a
-- evento (crm_notificacoes_eventos), marcar como lida e histórico.
--
-- O CRM não tem tabela `tenants` própria (identidade é global via
-- kyvvo-platform) — diferente do Studio, que já tem usuarios.email e
-- tenants.whatsapp prontos pra mandar e-mail/WhatsApp de admin. Aqui o
-- destino é capturado uma vez em crm_configuracoes (tela Notificações >
-- Regras) e reaproveitado por qualquer tipo com o canal ligado.
alter table crm_configuracoes add column notificacao_email text;
alter table crm_configuracoes add column notificacao_whatsapp text;

-- Sem coluna "referencia" (data/id de outro registro) de propósito — ao
-- contrário do Studio (agendamento tem uma data pra abrir a Agenda nela), o
-- domínio do CRM (pedido) não tem um "lugar certo" análogo pra navegar; o
-- clique no item leva pra Pedidos (lista geral), igual já fazia
-- pedidos_parados.
create table crm_notificacoes_eventos (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  chave text not null,
  titulo text not null,
  detalhe text,
  lida boolean not null default false,
  lida_em timestamptz,
  criado_em timestamptz not null default now()
);

create index idx_crm_notificacoes_eventos_tenant_chave on crm_notificacoes_eventos (tenant_id, chave, criado_em desc);
create index idx_crm_notificacoes_eventos_tenant_pendentes on crm_notificacoes_eventos (tenant_id, chave) where lida = false;
