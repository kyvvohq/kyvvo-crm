-- Suporte de schema pro redesenho de Clientes/Pedidos pedido pelo Bruno
-- (2026-09-25) — ver issues no GitHub pro trabalho de UI ainda pendente.
-- Migration só cobre as duas colunas novas, sem risco de dado existente
-- (both nullable/com default seguro).

alter table crm_pedidos add column if not exists prioridade text
  check (prioridade in ('altissima', 'alta', 'media', 'baixa'));
create index crm_pedidos_prioridade_idx on crm_pedidos (tenant_id, prioridade) where prioridade = 'altissima';

-- Cliente "bloqueado" = não deve ser contactado/atendido (kebab menu:
-- Bloquear/Desbloquear). Não usa o mesmo campo de whatsapp_opt_out (que
-- não existe neste produto ainda) — é uma decisão manual da equipe, não
-- um opt-out do próprio cliente.
alter table crm_clientes add column if not exists bloqueado boolean not null default false;

-- CPF (pessoa física) e CNPJ (pessoa jurídica) como colunas separadas —
-- cliente pode ser um ou outro, a UI mostra um único rótulo "CPF/CNPJ".
alter table crm_clientes add column if not exists cnpj text;
