-- Agente de atendimento por IA (Fase 2) — conversas, mensagens e anexos.
-- Estende as tabelas do bot por lista (005/014) em vez de duplicá-las: o
-- agente e o bot compartilham a mesma conversa por (tenant, telefone). O
-- `estado` existente continua sendo o passo do bot por lista; a situação do
-- atendimento (quem está falando com a cliente) é uma coluna nova.

-- Canal: o número ganha o modo de conexão com a Meta (coexistência com o
-- WhatsApp Business app ou número só na API) e um status.
alter table crm_whatsapp_numeros
  add column modo text not null default 'api' check (modo in ('coexistencia', 'api')),
  add column status text not null default 'ativo' check (status in ('ativo', 'pausado', 'desconectado'));

alter table crm_conversas_whatsapp
  add column cliente_id uuid references crm_clientes(id) on delete set null,
  add column situacao text not null default 'bot'
    check (situacao in ('bot', 'aguardando_equipe', 'humano', 'encerrada')),
  add column ultima_msg_cliente_em timestamptz,
  add column janela_expira_em timestamptz,   -- última mensagem da cliente + 24h
  add column pausada_ate timestamptz;        -- agente em silêncio até aqui (humano respondeu)
create index crm_conversas_whatsapp_situacao_idx on crm_conversas_whatsapp (tenant_id, situacao);

-- Arquivos recebidos (imagem, documento/STL...). Guardam só a referência do
-- armazenamento (S3 ou disco, ver lib/armazenamento.js) — nunca o binário.
create table crm_anexos (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  pedido_id uuid references crm_pedidos(id) on delete set null,
  mensagem_id uuid references crm_mensagens_whatsapp(id) on delete set null,
  chave_armazenamento text not null,         -- prefixo sempre <tenant_id>/...
  nome_arquivo text,
  mime text,
  tamanho bigint,
  sha256 text,
  criado_em timestamptz not null default now()
);
create index crm_anexos_tenant_pedido_idx on crm_anexos (tenant_id, pedido_id);
create index crm_anexos_tenant_mensagem_idx on crm_anexos (tenant_id, mensagem_id);

alter table crm_mensagens_whatsapp
  add column wamid text,                     -- id da Meta; idempotência por tenant
  add column autor text check (autor in ('cliente', 'agente', 'humano', 'sistema')),
  add column anexo_id uuid references crm_anexos(id) on delete set null,
  add column status_entrega text,            -- sent | delivered | read | failed
  add column categoria_cobranca text,        -- do webhook de status, quando vier
  add column tokens_in integer,
  add column tokens_out integer,
  add column modelo text;
create unique index crm_mensagens_whatsapp_wamid_uniq
  on crm_mensagens_whatsapp (tenant_id, wamid) where wamid is not null;
