-- Expande o bot de WhatsApp (pedido do Bruno, 2026-09-24): endereço de
-- entrega no cadastro do cliente (perguntado pelo bot só quando falta) e
-- arquivos anexados a um pedido (STL/foto/etc, um pedido pode ter vários).

-- crm_clientes já tem cep/cidade/uf (001_init.sql) — faltava número e
-- complemento pra formar um endereço completo de entrega.
alter table crm_clientes add column if not exists numero text;
alter table crm_clientes add column if not exists complemento text;

-- Arquivo é baixado da Cloud API da Meta e persistido em disco (volume do
-- container, ver lib/whatsapp-media.js) — a linha aqui só referencia onde
-- ele está gravado. Um pedido pode ter 0 (fluxo sem arquivo, referência por
-- texto/foto avulsa) ou vários arquivos (STL + fotos de referência etc.).
create table crm_pedidos_arquivos (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references crm_pedidos(id) on delete cascade,
  nome_arquivo text,
  caminho_arquivo text not null,
  tipo_mime text,
  media_id_whatsapp text,
  criado_em timestamptz not null default now()
);

create index crm_pedidos_arquivos_pedido_idx on crm_pedidos_arquivos (pedido_id);
