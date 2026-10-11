-- E-mail de aniversário (painel > Aniversariantes do mês) precisa de um
-- assunto além do texto — coluna nova, nula pra todo mundo exceto os
-- modelos de e-mail (hoje só 'aniversario_email'). WhatsApp continua sem
-- assunto (nulo).
alter table crm_modelos_mensagem add column assunto text;

-- Backfill: inicializarModelosPadrao (lib/mensagens.js) só semeia modelo em
-- tenant novo (sai de cara se já existe qualquer linha) — sem isto, tenant
-- já existente nunca ganharia a linha 'aniversario_email' nova.
insert into crm_modelos_mensagem (tenant_id, chave, texto, assunto)
select distinct tenant_id,
  'aniversario_email',
  'Olá {{nome}},' || chr(10) || chr(10) || 'A equipe deseja um feliz aniversário, com muita saúde e realizações!',
  'Feliz aniversário, {{nome}}! 🎉'
from crm_modelos_mensagem
on conflict (tenant_id, chave) do nothing;
