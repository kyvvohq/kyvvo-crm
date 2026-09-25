-- Ficha do cliente (pedido do Bruno, 2026-09-25) precisa listar "número do
-- pedido" e "data de entrega" no histórico — nenhum dos dois existia.
--
-- `numero`: sequencial por tenant (não é um id global, é o "pedido nº 1, nº
-- 2..." que o dono do negócio reconhece), backfill via row_number() pra quem
-- já tem pedido; dali em diante a aplicação calcula
-- `coalesce(max(numero),0)+1` dentro da mesma transação de criação do
-- pedido (mesmo tenant nunca cria dois pedidos concorrentes o bastante pra
-- precisar de trava/sequence dedicada nesse volume).
alter table crm_pedidos add column if not exists numero integer;

update crm_pedidos p set numero = sub.numero
from (
  select id, row_number() over (partition by tenant_id order by criado_em) as numero
  from crm_pedidos
) sub
where sub.id = p.id and p.numero is null;

alter table crm_pedidos alter column numero set not null;
create unique index if not exists crm_pedidos_tenant_numero_uniq on crm_pedidos (tenant_id, numero);

alter table crm_pedidos add column if not exists data_entrega date;
