-- US28: flag explícito de "esta é a etapa de pronto pra envio/retirada" em
-- vez da heurística por posição (última 'aberta' antes da primeira 'ganha').
-- Só uma etapa por conta pode ter eh_pronto = true — garantido na aplicação
-- (index.js), não aqui, pra manter a migration simples.
alter table crm_etapas add column if not exists eh_pronto boolean not null default false;
