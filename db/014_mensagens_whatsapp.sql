-- Histórico de mensagens do bot de WhatsApp (pedido do Bruno: tela
-- Configurações > WhatsApp > Conversas mostrando o histórico de verdade).
-- Até aqui o bot só guardava o ESTADO atual da conversa
-- (crm_conversas_whatsapp, 1 linha por telefone, sobrescrita a cada passo)
-- — nunca o texto trocado. Esta tabela é um log append-only, nunca
-- sobrescrita: cada mensagem recebida OU enviada vira uma linha nova.
create table crm_mensagens_whatsapp (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  telefone_e164 text not null,
  direcao text not null check (direcao in ('recebida', 'enviada')),
  tipo text not null default 'texto',
  conteudo text not null,
  criado_em timestamptz not null default now()
);
create index crm_mensagens_whatsapp_tenant_telefone_idx on crm_mensagens_whatsapp (tenant_id, telefone_e164, criado_em);
