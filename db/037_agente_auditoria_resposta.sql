-- Auditoria do que o modelo realmente escreveu e do aviso de fora do horário.
-- resposta_original guarda o texto do modelo antes do pós-filtro (a cliente nunca o vê quando
-- bloqueado): serve para a equipe entender os bloqueios e para ajustar prompt e evals.
alter table crm_agente_execucoes
  add column resposta_original text,
  add column aviso_fora_horario boolean not null default false;
