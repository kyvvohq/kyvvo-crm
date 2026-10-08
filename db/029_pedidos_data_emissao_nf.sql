-- "Data emissão NF" no modal de edição do pedido. Até aqui a data de emissão
-- da NF-e só existia embutida em criado_em (importação de XML grava a emissão
-- como data do pedido) — sem campo próprio, não dava pra informar/corrigir a
-- emissão de pedidos que não vieram do XML. Coluna date (emissão é um dia,
-- sem hora) e backfill dos pedidos importados de NF-e a partir de criado_em,
-- no fuso de Brasília.
alter table crm_pedidos add column data_emissao_nf date;

update crm_pedidos
   set data_emissao_nf = (criado_em at time zone 'America/Sao_Paulo')::date
 where origem = 'nfe' and chave_nfe is not null and data_emissao_nf is null;
