-- Série da NF-e -> Origem (pedido do Bruno): cada opção de Origem (Cadastro
-- > Origens) pode ter uma série vinculada, pra importação de XML decidir a
-- origem certa sozinha (ex.: série 0003 = Shopee, 0004 = Mercado Livre) em
-- vez de tudo cair genérico em 'nfe'. Só faz sentido pra tipo='origem', mas
-- fica na mesma tabela genérica (sem check de tipo) por simplicidade —
-- nunca é lido/gravado pelos outros tipos.
alter table crm_opcoes_cadastro add column serie text;
create unique index crm_opcoes_cadastro_tenant_tipo_serie_uniq
  on crm_opcoes_cadastro (tenant_id, tipo, serie) where serie is not null;
