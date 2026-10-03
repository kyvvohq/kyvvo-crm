-- Reverte 025_resumo_ativo.sql — o card "Resumo" do Painel Hoje virou parte
-- padrão sempre ativa (pedido do Bruno, 2026-10-03: "o resumo não é um
-- módulo a ser liberado, ele será default"), não um módulo opt-in por
-- tenant. Coluna nunca chegou a ser usada de verdade em produção (nenhum
-- tenant teve tempo de ligar o toggle antes dele ser removido).
alter table crm_configuracoes drop column resumo_ativo;
