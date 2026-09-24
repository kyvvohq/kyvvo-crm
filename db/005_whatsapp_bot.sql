-- Bot exclusivo de atendimento por WhatsApp (primeiro caso: Basic 3D Print).
-- Diferente de People/Studio (um número por produto ou um número por tenant
-- já resolvido via tenants.meta_phone_number_id), o CRM ainda não tem tabela
-- de tenants local — precisa de um jeito de descobrir a que conta pertence
-- um número recebido no webhook sem depender de redeploy a cada tenant novo
-- que ganhar um bot dedicado.
create table crm_whatsapp_numeros (
  phone_number_id text primary key,
  tenant_id uuid not null,
  numero_exibido text,
  criado_em timestamptz not null default now()
);

-- Estado da conversa por tenant+telefone — o bot é um fluxo sequencial de
-- perguntas (seção "opção 1" do briefing da Basic): guarda em que passo o
-- cliente está e o que já respondeu, pra continuar de onde parou na
-- próxima mensagem recebida. Uma conversa "ativa" por vez (reinicia se o
-- cliente manda "oi" de novo depois de concluído/abandonado — resolvido na
-- aplicação, não aqui).
create table crm_conversas_whatsapp (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  telefone_e164 text not null,
  estado text not null,
  respostas jsonb not null default '{}',
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (tenant_id, telefone_e164)
);
