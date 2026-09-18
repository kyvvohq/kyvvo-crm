-- US26: dá visibilidade ao passo de onboarding que já existia (etapas padrão
-- criadas automaticamente por inicializarEtapasPadrao) sem mudar a criação em
-- si — só marca se a conta já revisou/confirmou a tela.
create table crm_onboarding (
  tenant_id uuid primary key,
  confirmado_em timestamptz,
  criado_em timestamptz not null default now()
);
