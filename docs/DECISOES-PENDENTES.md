# Decisões pendentes — Kyvvo CRM

Gerado no kickoff do projeto (2026-09-17), a partir do doc de instruções
("Instruções do Projeto — Kyvvo CRM"). Itens da seção 11 do doc + gaps
encontrados ao implementar o scaffold inicial. Nada aqui bloqueou o código já
commitado — são decisões que mudam comportamento ou destravam produção real.

## 1. Nome da coluna de isolamento: `conta_id` (doc) vs. `tenant_id` (código)

O doc chama a coluna de isolamento de tenant de `conta_id` em todas as
seções. Toda a plataforma existente (Studio, People, Platform) usa
`tenant_id`. Implementei com `tenant_id` pra seguir a convenção já existente
no repositório Kyvvo (seção 2 do doc: "seguir a stack e os padrões já
existentes"). Se `conta_id` for intencional (por exemplo, pra reforçar
"conta" como conceito de billing distinto de "tenant" técnico), é rename em
massa — melhor decidir agora do que depois de dados reais na Basic.

## 2. Módulo `crm` no kyvvo-platform e billing

Abri kyvvohq/kyvvo-platform#33: cadastra o módulo `crm`, aceita
`produto: 'crm'` no registro (conta nasce `ativo`, sem trial — copiei a
decisão do People por não ter nada melhor pra copiar) e expõe
`GET /api/auth/crm/acesso`. **Isso é um placeholder**: a seção 11 do doc
deixa "planos, limites e preço de mercado" e "condição exata da Basic como
cliente fundadora" em aberto. Quando isso for decidido, provavelmente o CRM
precisa da própria tabela `assinaturas` (como o People tem) — hoje o CRM não
tem nenhum controle de billing, todo tenant com o módulo ativo tem acesso
completo.

## 3. Infra de deploy (EC2)

- `crm.kyvvo.com.br` não existe — falta DNS + vhost nginx.
- O `docker-compose.yml` da EC2 (repo `kyvvo-infra`) não tem entrada `crm`;
  escolhi a porta **3005** (próxima livre depois de landing=3000,
  studio=3001, people=3002, platform=3003, admin=3004).
- **Capacidade**: o comentário do próprio `kyvvo-infra/docker-compose.yml`
  registra host com ~1.9GB de RAM e swap de 2GB como "folga". Os `mem_limit`
  dos 7 serviços atuais (postgres+n8n+landing+studio+people+platform+admin)
  já somam ~2GB. Adicionar um 8º serviço sem rever a instância EC2 é risco
  real de OOM em pico — vale medir uso real antes de subir o `crm` em
  produção, ou considerar upgrade de instância.
- Secrets do repo `kyvvo-crm` (`NPM_PACKAGES_TOKEN`, `EC2_HOST`, `EC2_USER`,
  `EC2_SSH_KEY_B64`, `CLAUDE_CODE_OAUTH_TOKEN` pro `agente.yml`) não foram
  configurados — não tenho os valores (só quem já os cadastrou nos outros
  repos tem). `deploy.yml` e `agente.yml` estão prontos como template, só não
  rodam ainda.

## 4. Heurística de "pedidos prontos" no Painel Hoje

O schema (seção 6 do doc) não tem um flag explícito de "esta etapa é
pronto/aguardando envio". Implementei uma heurística (`lib/etapas.js`,
`buscarEtapaPronto`): a última etapa `tipo='aberta'` antes da primeira etapa
`tipo='ganha'`, por ordem. Funciona certo pro funil padrão da Basic (Pronto →
Enviado/Entregue), mas quebra silenciosamente se uma conta configurar um
funil sem uma etapa "final aberta" clara. Melhor seria um campo explícito
(`crm_etapas.eh_pronto boolean`) — pequena migration, decisão de produto.

## 5. Notion — database das user stories

Seção 11 do doc: "confirmar com o Bruno qual database usar para o CRM antes
de criar histórias." Não criei nada no Notion. O backlog da Fase 1 está em
`docs/backlog-fase1.md` (Markdown) pra colar lá assim que a database for
escolhida.

## 6. Fatos externos não verificados nesta sessão

- Colunas exatas da exportação de pedidos do UpSeller (CPF, cidade, produtos)
  e onde o número do pedido aparece no XML da NF-e — precisa de um arquivo
  real da Basic (seção 9/11 do doc).
- Regras do TikTok Shop sobre material no pacote e contato fora da
  plataforma (a proibição da Shopee já está documentada no doc; TikTok não).
- Nome comercial definitivo do produto — usei "Kyvvo CRM" (nome do repo e do
  módulo) como provisório.
- Plataforma de e-commerce padrão pra Fase 2 (o doc cita Nuvemshop como
  exemplo, não como decisão).
