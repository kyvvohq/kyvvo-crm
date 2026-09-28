-- Origem "WhatsApp" protegida (pedido do Bruno): o bot grava origem =
-- 'WhatsApp' em todo cliente/pedido criado por ele (lib/bot-whatsapp.js) —
-- sem essa opção existir de verdade em crm_opcoes_cadastro, o dono podia
-- desativar ou remover a linha e o bot continuaria gravando um valor
-- inexistente na lista, quebrando o filtro/combobox de Origem silenciosamente.
-- `sistema = true` marca uma opção como gerida pelo código, não pelo
-- usuário — a UI (opcoes-cadastro.html) esconde Desativar/Remover pra ela.
alter table crm_opcoes_cadastro add column sistema boolean not null default false;

-- Garante a linha "WhatsApp" pra todo tenant existente, mesmo quem já tinha
-- cadastrado uma "whatsapp" minúscula à mão (o índice único já existente é
-- por lower(valor), então o conflito recai nela e só promove pra sistema).
-- Não existe tabela `tenants` neste banco (kyvvo_crm é isolado do
-- kyvvo-platform, tenant_id é só uma coluna solta, sem FK) — usa
-- `crm_etapas` como fonte de "todo tenant que já existe", porque
-- inicializarEtapasPadrao (lib/etapas.js) roda no primeiro acesso
-- autenticado de todo tenant, então cobre 100% de quem já usou o CRM.
insert into crm_opcoes_cadastro (tenant_id, tipo, valor, sistema)
select distinct tenant_id, 'origem', 'WhatsApp', true from crm_etapas
on conflict (tenant_id, tipo, lower(valor)) do update set sistema = true;
