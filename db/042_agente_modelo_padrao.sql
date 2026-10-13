-- Modelo padrão do agente: claude-haiku-5-5. Escolhido pelos evals reais (rodada de 2026-10-13):
-- mais acertos nos casos do doc 04 + adversariais e ~5x mais barato que o claude-haiku-4-5.
-- Só muda o padrão para contas novas; contas existentes mantêm o modelo que já têm.
alter table crm_agente_config alter column modelo_runtime set default 'claude-haiku-5-5';
