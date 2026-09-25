-- Revisão do fluxo do bot (2026-09-24, mesmo dia da 006): endereço de
-- entrega vira UMA pergunta só (texto livre, "endereço completo numa única
-- mensagem") em vez de CEP/número/complemento em 3 perguntas separadas —
-- mais rápido pro cliente responder no WhatsApp. numero/complemento
-- (006) ficam sem uso a partir de agora — não removidos (nenhuma migration
-- deste projeto até hoje faz DROP COLUMN; convenção é só aditiva).
alter table crm_clientes add column if not exists endereco_completo text;
