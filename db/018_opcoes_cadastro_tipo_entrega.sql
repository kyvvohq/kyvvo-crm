-- Tipo de frete (pedido do Bruno) vira uma 3ª opção de cadastro, mesmo molde
-- de segmento/origem — CRUD em Configurações > Cadastro > nova aba.
alter table crm_opcoes_cadastro drop constraint crm_opcoes_cadastro_tipo_check;
alter table crm_opcoes_cadastro add constraint crm_opcoes_cadastro_tipo_check check (tipo in ('segmento', 'origem', 'tipo_entrega'));
