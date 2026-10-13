# CLAUDE.md

Guia para o Claude Code (claude.ai/code) neste repositório.

## O que é este repo

Kyvvo CRM — base de clientes, funil de pedidos e relacionamento pra negócios
que vendem por marketplace, atendem pelo WhatsApp e produzem sob encomenda.
Terceiro produto da Plataforma Kyvvo (junto com Studio e People). Ainda **não
está em produção** — scaffold inicial criado a partir do doc de instruções do
projeto (ver docs/DECISOES-PENDENTES.md pra tudo que ainda depende do Bruno).

Cliente fundadora: Basic 3D Print (Uberlândia, impressão 3D). A configuração
dela (etapas do funil, campos customizados) é a primeira, nunca o modelo —
etapas/campos/origens são sempre configuráveis por conta.

Um serviço Fastify único, sem build e sem bundler. Layout flat na raiz:
`index.js`, `lib/`, `db/`, `public/`, `test/`. Porta 3005 (próxima livre —
landing=3000, studio=3001, people=3002, platform=3003, admin=3004).

## Comandos

```bash
npm start          # node index.js  (precisa DATABASE_URL, PLATFORM_URL; o agente de IA também ANTHROPIC_API_KEY)
npm test           # node --test test/*.test.js  (testes com banco usam DATABASE_URL e pulam sem ele)
npm run evals      # evals do agente de IA em modo mock (sem rede); com --real chama o modelo de verdade (ver evals/README.md)
node scripts/seed-agente.js --tenant <uuid> [--modo rascunho]   # configura o agente de uma conta (docs/runbooks/onboarding-whatsapp-basic.md)
```

`npm ci` precisa de `NPM_PACKAGES_TOKEN` no ambiente — o `.npmrc` aponta
`@kyvvohq` pro GitHub Packages e lê esse token.

## Arquitetura

**`index.js`** monta o Fastify, registra `@fastify/{jwt,static,multipart}`,
serve `public/` em `/crm/`. O design system (`/ds/`) não é servido por este arquivo — vem do
proxy da infra; localmente os assets de `/ds/` não existem (dá para baixar de
https://crm.kyvvo.com.br/ds/ para pré-visualizar telas). Todas as rotas de API vivem
nesse arquivo (não há `routes/`) — mesmo padrão do kyvvo-people.

**Auth (atual)**: a sessão é o token RS256 do `kyvvo-platform` verificado via
`@kyvvohq/platform-client` (`fastify.authenticate`, `lib/resolver-sessao.js`); os claims trazem
`tenantId` e `userId` (`request.user`). O parágrafo abaixo descreve o desenho inicial e está
defasado (o CRM não emite mais JWT próprio).

**Auth (desenho inicial, defasado)**: o CRM **não tem tabela de usuário/tenant**. `POST /crm/api/login`
valida servidor-a-servidor contra o `kyvvo-platform` (`PLATFORM_URL`, `POST
/api/auth/login` + `GET /api/auth/crm/acesso`) — qualquer usuário Kyvvo com o
módulo `crm` ativo entra — e então emite um JWT **interno** próprio (12h,
`CRM_JWT_SECRET`). **A rota `/api/auth/crm/acesso` e o módulo `crm` ainda
precisam existir no kyvvo-platform** (PR companion nesse repo) antes do login
funcionar de verdade.

**`lib/`:**
- `db.js` — `pool` (pg) + `migrar()` sobre `@kyvvohq/db-migrate`.
- `telefone.js` — normalização pra E.164; **chave primária de identidade de
  cliente** (idêntico ao `kyvvo-people/lib/telefone.js`).
- `clientes.js` — achar-ou-criar cliente por telefone (criação rápida de
  pedido, seção 7.2 do doc); métricas calculadas (nunca digitadas, seção 6).
- `etapas.js` — modelo de segmento único do MVP ("Produção sob encomenda" —
  a config da Basic virando padrão de onboarding, seção 5) + heurística de
  "etapa pronto" do Painel Hoje (ver docs/DECISOES-PENDENTES.md #4).

## Agente de atendimento por IA (Fase 2)

Agente de WhatsApp que qualifica, coleta o briefing, cria **pedido rascunho** e encaminha para a equipe — **não orça**
(valor/prazo/frete/pagamento/estoque/desconto são sempre da equipe, garantido em código). Spec: `docs/basic/prompt-agente.md`;
decisões e pendências: `docs/agente/pendencias.md`; LGPD: `docs/agente/lgpd.md`; onboarding do número: `docs/runbooks/onboarding-whatsapp-basic.md`.

- **Fluxo**: o kyvvo-platform encaminha o webhook da Meta (segredo `x-webhook-internal-secret`; a assinatura da Meta é validada lá) →
  `lib/agente/recebimento.js` grava a mensagem (idempotente por `wamid`) e responde 200 → `processador.js` (lock por conversa,
  varredura a cada 60 s; a própria `crm_mensagens_whatsapp` é a fila, `processada_em` nulo = pendente) → `executor.js` (prompt em camadas
  com cache, ferramentas server-side, até 4 iterações, **pós-filtro**, gatilhos garantidos em código, rascunho x automático).
- **Só atua se** `crm_agente_config.modo <> 'desligado'`; senão o bot por lista antigo (`lib/bot-whatsapp.js`) segue intacto.
- **Isolamento**: o `tenant_id` das ferramentas vem do servidor, nunca do modelo; nenhuma ferramenta recebe id de cliente/pedido.
- **Modelo**: por conta (`modelo_runtime`, padrão `claude-haiku-5-5`, escolhido por evals reais: 96%). Testes **nunca** chamam a Meta nem a Anthropic reais.
- **Telas/rotas**: `public/atendimento.html`, `/crm/api/agente/*` (conversas, sugestões, assumir/devolver, métricas, liga/desliga), card no Painel Hoje.
- **Mudou o prompt, o filtro ou as ferramentas?** Rode `npm run evals -- --real` e compare antes de subir (custa centavos).
- Mídia recebida fica em disco (`uploads/agente/<tenant>/`) atrás de `lib/armazenamento.js`; S3 só quando houver infra.

## Banco

- Postgres **próprio deste serviço**, DB `kyvvo_crm`.
- Tabelas com prefixo `crm_`, todas com `tenant_id` (o doc de instruções do
  projeto chama essa coluna de "conta_id" — a plataforma inteira usa
  `tenant_id`, seguimos a convenção existente; ver DECISOES-PENDENTES #1).
- Migrations = SQL sequencial `db/NNN_descricao.sql`, aplicadas em ordem pelo
  runner `@kyvvohq/db-migrate` (tabela `_migrations`). Uma mudança de schema é
  um arquivo novo numerado — sem down migration.
- Multi-tenancy é por query (`WHERE tenant_id = $1`), sem RLS.
- **Regras obrigatórias de modelagem** (seção 6 do doc): pagamento é status
  paralelo à etapa (nunca bloqueia produção); métricas são sempre calculadas;
  importação é idempotente por identificador externo / chave de NF-e; eventos
  (`crm_eventos`) são imutáveis — não editar linha, só inserir.

## Escopo

Fase 1 (MVP, ver seção 7 do doc): clientes, pedidos em kanban, importação
(UpSeller/NF-e/CSV), formulário de captação, segmentos + sorteio, Painel Hoje.

**Implementado:** auth (login + cadastro self-service), landing pública,
clientes (CRUD + busca + segmento + métricas + timeline), pedidos em kanban
2D — raia = recurso de produção (`crm_recursos`, ex.: impressoras 3D; raia
fixa "Sem recurso") × coluna = etapa, ambas arrastáveis; etapas totalmente
editáveis pelo próprio quadro (criar/renomear/apagar/reordenar, mesmo padrão
do `kyvvo-people/quadro.html`); quantidade de item na criação rápida; máscara
de moeda e asterisco vermelho nos campos obrigatórios; Painel Hoje.

**Atenção**: as listas "Implementado"/"Não implementado" abaixo estão defasadas — importações, formulários, campanhas,
segmentos, automações e o agente de IA já existem; confie no `git log` e em `docs/backlog-fase1.md`.

**Não implementado ainda** (ver `docs/backlog-fase1.md`): importação de
arquivos, formulário de captação público, segmentos salvos, sorteio, CRUD de
produtos/tags/campos customizados. `pedidos.html` ainda usa `window.prompt()`
nativo pro motivo de perda — travou testes de automação de browser, trocar
por modal é o próximo ajuste óbvio de UX.

Ao propor funcionalidade nova, indique a fase (1/2/3) e qual das três
perguntas do produto ela responde (quem são meus clientes / em que pé está
cada pedido / com quem preciso falar hoje) — se não responder nenhuma,
questione antes de implementar.

## Secrets

Nunca commitar. Seguem o padrão dos outros serviços: AWS SSM `SecureString`
em `/kyvvo/crm/<KEY>`, materializado na EC2 por `gen-env-from-ssm.sh` — mas
isso **ainda não foi configurado** pra este serviço (ver DECISOES-PENDENTES).

## CI / deploy

- **`gate.yml`** (toda PR): `npm ci`, migrations do zero pelo runner real
  contra um `postgres:16` efêmero, `npm test`. Job `caminhos-protegidos`
  reprova PR que toca `.github/workflows/`, `db/`, `.npmrc`, `package.json`,
  `Dockerfile` sem a label `revisado:infra` (Dependabot isento).
- **`deploy.yml`** existe como template (mesmo formato do kyvvo-people) mas
  **não está wireado**: faltam os secrets do repo (`NPM_PACKAGES_TOKEN`,
  `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY_B64`) e a entrada do serviço `crm` no
  `docker-compose` da EC2 (`kyvvo-infra`).

## Testes

`test/telefone.test.js` é `node --test`, função pura, sem Postgres. Já
`test/smoke.test.js` sobe o app Fastify de verdade (`build()` + `.inject()`)
contra o Postgres do CI — sem mocks, ver
[[feedback_run_real_tests_not_just_syntax_check]].
