-- Módulo "Resumo" do Painel Hoje (pedido do Bruno, 2026-10-03) — liberado
-- por tenant pelo kyvvo-admin (catálogo 'crm_resumo' em tenant_modulos,
-- banco compartilhado do Studio/admin), sincronizado aqui via admin-interno
-- (POST/PATCH /crm/admin-interno/resumo-ativo) porque o CRM tem banco
-- próprio e não enxerga aquela tabela diretamente.
alter table crm_configuracoes add column resumo_ativo boolean not null default false;
