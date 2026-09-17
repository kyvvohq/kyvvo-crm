-- Kyvvo CRM — schema inicial (Fase 1 MVP), a partir do doc de instruções do
-- projeto (seção 6). Isolamento por tenant_id em toda tabela (mesma
-- convenção de Studio/People/Platform — o doc chama de "conta_id", mas o
-- nome de coluna real na plataforma inteira é tenant_id; ver
-- docs/DECISOES-PENDENTES.md #1). Tenant é gerenciado pelo kyvvo-platform,
-- não existe tabela `tenants` aqui — só a referência solta ao id (mesmo
-- padrão do kyvvo-people).

create extension if not exists pgcrypto;

-- ===========================================================================
-- clientes
-- ===========================================================================
create table crm_clientes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  nome text not null,
  telefone text,                          -- E.164, normalizado na aplicação
  email text,
  cpf text,
  cidade text,
  uf text,
  cep text,
  data_nascimento date,
  origem text,
  observacoes text,
  consentimento_data timestamptz,
  consentimento_canal text,
  consentimento_texto text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

-- Identidade: telefone é a chave principal de dedupe: único por tenant
-- quando presente. Cliente "sem contato" (importado sem telefone) fica nulo
-- e não conflita. CPF é chave secundária (não única no schema — mesma
-- pessoa pode aparecer com CPFs divergentes em fontes ruins; a sugestão de
-- mescla é feita pela aplicação, nunca automática, ver seção 6 do doc).
create unique index crm_clientes_tenant_telefone_uniq on crm_clientes (tenant_id, telefone) where telefone is not null;
create index crm_clientes_tenant_cpf_idx on crm_clientes (tenant_id, cpf) where cpf is not null;
create index crm_clientes_tenant_nome_idx on crm_clientes (tenant_id, lower(nome));
create index crm_clientes_tenant_idx on crm_clientes (tenant_id);

-- ===========================================================================
-- campos customizados (por conta) e seus valores (por cliente)
-- ===========================================================================
create table crm_campos_customizados (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  chave text not null,
  label text not null,
  tipo text not null check (tipo in ('texto', 'numero', 'booleano', 'data', 'selecao')),
  opcoes jsonb,                           -- lista de opções quando tipo = 'selecao'
  ordem int not null default 0,
  criado_em timestamptz not null default now(),
  unique (tenant_id, chave)
);

create table crm_clientes_valores (
  cliente_id uuid not null references crm_clientes(id) on delete cascade,
  campo_id uuid not null references crm_campos_customizados(id) on delete cascade,
  valor text,
  primary key (cliente_id, campo_id)
);

-- ===========================================================================
-- tags
-- ===========================================================================
create table crm_tags (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  nome text not null,
  criado_em timestamptz not null default now(),
  unique (tenant_id, nome)
);

create table crm_clientes_tags (
  cliente_id uuid not null references crm_clientes(id) on delete cascade,
  tag_id uuid not null references crm_tags(id) on delete cascade,
  primary key (cliente_id, tag_id)
);

-- ===========================================================================
-- produtos
-- ===========================================================================
create table crm_produtos (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  nome text not null,
  categoria text,
  preco_referencia numeric(10,2),
  identificador_externo text,             -- SKU ou código de nota
  criado_em timestamptz not null default now()
);

create index crm_produtos_tenant_idx on crm_produtos (tenant_id);

-- ===========================================================================
-- etapas do funil (configurável por conta)
-- ===========================================================================
create table crm_etapas (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  nome text not null,
  ordem int not null,
  tipo text not null check (tipo in ('aberta', 'ganha', 'perdida')),
  prazo_alerta_dias int,
  criado_em timestamptz not null default now(),
  unique (tenant_id, nome)
);

create index crm_etapas_tenant_ordem_idx on crm_etapas (tenant_id, ordem);

-- ===========================================================================
-- pedidos
-- ===========================================================================
create table crm_pedidos (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  cliente_id uuid not null references crm_clientes(id) on delete restrict,
  etapa_id uuid not null references crm_etapas(id) on delete restrict,
  origem text not null,                   -- marketplace, whatsapp, site, retirada etc. (cadastro por conta)
  valor_total numeric(10,2) not null default 0,
  status_pagamento text not null default 'pendente' check (status_pagamento in ('pendente', 'parcial', 'pago')),
  valor_recebido numeric(10,2) not null default 0,
  tipo_entrega text,                      -- retirada, correios, uber, entrega local etc. (cadastro por conta)
  frete numeric(10,2),
  motivo_perda text,
  identificador_externo text,             -- número do pedido na plataforma de origem
  chave_nfe text,                         -- chave de acesso da NF-e, quando houver
  entrou_na_etapa_em timestamptz not null default now(),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

-- Idempotência de importação: mesmo pedido de origem (UpSeller etc.) não
-- duplica. NULL é permitido (pedido lançado manualmente sem origem externa).
create unique index crm_pedidos_tenant_identificador_externo_uniq
  on crm_pedidos (tenant_id, origem, identificador_externo) where identificador_externo is not null;
create unique index crm_pedidos_tenant_chave_nfe_uniq
  on crm_pedidos (tenant_id, chave_nfe) where chave_nfe is not null;
create index crm_pedidos_tenant_etapa_idx on crm_pedidos (tenant_id, etapa_id);
create index crm_pedidos_tenant_cliente_idx on crm_pedidos (tenant_id, cliente_id);
create index crm_pedidos_tenant_idx on crm_pedidos (tenant_id);

create table crm_pedidos_itens (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references crm_pedidos(id) on delete cascade,
  produto_id uuid references crm_produtos(id) on delete set null,
  descricao text,                         -- item livre, quando não há produto cadastrado
  quantidade numeric(10,2) not null default 1,
  valor_unitario numeric(10,2) not null default 0
);

create index crm_pedidos_itens_pedido_idx on crm_pedidos_itens (pedido_id);

-- ===========================================================================
-- eventos (linha do tempo imutável de cliente e pedido)
-- ===========================================================================
create table crm_eventos (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  cliente_id uuid references crm_clientes(id) on delete cascade,
  pedido_id uuid references crm_pedidos(id) on delete cascade,
  tipo text not null,                     -- criacao, mudanca_etapa, pagamento, importacao, formulario, sorteio, mensagem_enviada...
  dados jsonb,
  ator_id uuid,                           -- usuário Kyvvo que fez a ação, null quando é o sistema
  criado_em timestamptz not null default now()
);

create index crm_eventos_cliente_idx on crm_eventos (cliente_id, criado_em desc);
create index crm_eventos_pedido_idx on crm_eventos (pedido_id, criado_em desc);
create index crm_eventos_tenant_idx on crm_eventos (tenant_id, criado_em desc);

-- ===========================================================================
-- segmentos (filtros salvos)
-- ===========================================================================
create table crm_segmentos (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  nome text not null,
  filtros jsonb not null,
  criado_em timestamptz not null default now()
);

create index crm_segmentos_tenant_idx on crm_segmentos (tenant_id);

-- ===========================================================================
-- formulários de captação
-- ===========================================================================
create table crm_formularios (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  nome text not null,
  slug text not null,
  campos jsonb not null,                  -- lista de campos escolhidos pela conta
  tag_id uuid references crm_tags(id) on delete set null,
  ativo boolean not null default true,
  criado_em timestamptz not null default now(),
  unique (tenant_id, slug)
);

create table crm_formularios_respostas (
  id uuid primary key default gen_random_uuid(),
  formulario_id uuid not null references crm_formularios(id) on delete cascade,
  cliente_id uuid references crm_clientes(id) on delete set null,
  respostas jsonb not null,
  criado_em timestamptz not null default now()
);

create index crm_formularios_respostas_formulario_idx on crm_formularios_respostas (formulario_id);

-- ===========================================================================
-- sorteios
-- ===========================================================================
create table crm_sorteios (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  segmento_id uuid references crm_segmentos(id) on delete set null,
  participantes jsonb not null,           -- lista congelada de cliente_id no momento do sorteio
  vencedores jsonb not null,
  ator_id uuid not null,
  criado_em timestamptz not null default now()
);

create index crm_sorteios_tenant_idx on crm_sorteios (tenant_id);

-- ===========================================================================
-- modelos de mensagem (texto com variáveis, por conta — links wa.me no MVP)
-- ===========================================================================
create table crm_modelos_mensagem (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  chave text not null,                    -- ex: 'orcamento_parado', 'aniversario', 'pedido_pronto'
  texto text not null,
  criado_em timestamptz not null default now(),
  unique (tenant_id, chave)
);

-- ===========================================================================
-- importações
-- ===========================================================================
create table crm_importacoes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  tipo text not null check (tipo in ('pedidos_upseller', 'nfe_xml', 'csv_generico')),
  arquivo text,
  status text not null default 'processando' check (status in ('processando', 'concluido', 'erro')),
  criados int not null default 0,
  atualizados int not null default 0,
  com_erro int not null default 0,
  erro text,
  criado_em timestamptz not null default now(),
  concluido_em timestamptz
);

create index crm_importacoes_tenant_idx on crm_importacoes (tenant_id, criado_em desc);
