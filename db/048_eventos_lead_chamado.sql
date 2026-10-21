-- crm_eventos já é genérico (cliente_id/pedido_id nullable) — só precisa das
-- duas FKs novas, nullable, pra continuar sendo a timeline única também pra
-- Leads e Chamados.
alter table crm_eventos
  add column lead_id uuid references crm_leads(id) on delete cascade,
  add column chamado_id uuid references crm_chamados(id) on delete cascade;
create index crm_eventos_lead_idx on crm_eventos (lead_id, criado_em desc);
create index crm_eventos_chamado_idx on crm_eventos (chamado_id, criado_em desc);
