-- Campanhas com disparo real (WhatsApp / e-mail) e sorteio de brindes ou
-- descontos. Até aqui crm_segmentos era só um "filtro salvo" (chamado de
-- campanha na tela): dava pra pré-visualizar, exportar CSV e sortear, mas não
-- existia envio. Em vez de criar outra tabela, a própria crm_segmentos ganha o
-- que uma campanha precisa (tipo, canal, conteúdo, prêmio, status) — as rotas
-- /crm/api/segmentos continuam as mesmas e as campanhas antigas viram
-- rascunhos sem canal.
alter table crm_segmentos
  add column tipo text not null default 'disparo' check (tipo in ('disparo', 'sorteio')),
  add column canal text check (canal in ('whatsapp', 'email')),
  add column whatsapp_template text,
  add column assunto text,
  add column corpo text,
  add column premio_tipo text check (premio_tipo in ('brinde', 'desconto_percentual', 'desconto_valor')),
  add column premio_descricao text,
  add column premio_valor numeric(12, 2),
  add column qtd_vencedores integer,
  add column notificar_vencedores boolean not null default true,
  add column status text not null default 'rascunho' check (status in ('rascunho', 'enviando', 'enviada', 'sorteada')),
  add column total_publico integer,
  add column enviado_em timestamptz,
  add column atualizado_em timestamptz not null default now();

-- Resultado por destinatário (disparo da campanha ou aviso aos ganhadores do
-- sorteio) — alimenta os contadores da lista e o "Ver envios".
create table crm_campanhas_envios (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  campanha_id uuid not null references crm_segmentos(id) on delete cascade,
  cliente_id uuid references crm_clientes(id) on delete set null,
  finalidade text not null default 'disparo' check (finalidade in ('disparo', 'sorteio')),
  canal text not null check (canal in ('whatsapp', 'email')),
  destino text,
  status text not null check (status in ('enviado', 'erro', 'ignorado')),
  motivo text,
  criado_em timestamptz not null default now()
);
create index crm_campanhas_envios_campanha_idx on crm_campanhas_envios (campanha_id, criado_em);

-- O sorteio guarda o prêmio como estava no momento (a campanha pode mudar
-- depois) e o resultado do aviso aos ganhadores.
alter table crm_sorteios
  add column premio jsonb,
  add column notificacao jsonb;
