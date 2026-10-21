-- Saldo de créditos de WhatsApp das automações (pedido do Bruno, 2026-10-21).
-- 1 crédito = 1 mensagem de template enviada com sucesso por uma automação
-- (lib/automacoes.js). Dois saldos separados:
--   saldo_plano    — cota mensal incluída no plano contratado, "usar ou
--                    perder" (reseta pro valor cheio todo mês, ver
--                    lib/creditos.js#garantirRenovacaoMensal).
--   saldo_comprado — pacotes avulsos (Automações > Comprar créditos),
--                    nunca expira, nunca reseta.
-- ciclo_renovado_em fica NULL até a primeira renovação da cota mensal
-- rodar (lib/creditos.js) — não pode nascer já preenchido na compra avulsa
-- (creditarCompra), senão a cota do plano nunca seria aplicada pra quem
-- comprou crédito antes de qualquer disparo.
-- Compra é feita no kyvvo-platform (Asaas) — o platform chama de volta pra
-- creditar aqui (ver POST /crm/plataforma-interno/creditos/confirmar).
create table if not exists crm_creditos (
  tenant_id uuid primary key,
  saldo_plano integer not null default 0,
  saldo_comprado integer not null default 0,
  ciclo_renovado_em timestamptz,
  atualizado_em timestamptz not null default now()
);
