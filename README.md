# Kyvvo CRM

Base de clientes, funil de pedidos e relacionamento para negócios que vendem por marketplace, atendem pelo WhatsApp e produzem sob encomenda ou orçamento. Terceiro produto da Plataforma Kyvvo (junto com Studio e People).

Responde três perguntas: quem são meus clientes, em que pé está cada pedido, com quem eu preciso falar hoje. Não é loja virtual nem ERP — é a camada de relacionamento por cima da loja/marketplace que o cliente já usa.

Multi-tenant: login valida contra o serviço de auth do Kyvvo (`POST /api/auth/login` + `GET /api/auth/crm/acesso`, server-to-server) — qualquer usuário Kyvvo com o módulo "crm" ativo no tenant consegue entrar. Dados isolados por `tenant_id`. Serviço separado — banco de dados, container e segredos isolados; o CRM nunca acessa `usuarios`/`tenants` diretamente. Deploy planejado em `crm.kyvvo.com.br` (ver docs/DECISOES-PENDENTES.md).

Cliente fundadora: Basic 3D Print (Uberlândia). A configuração dela (etapas, campos) é a primeira, não o modelo — tudo isso é configurável por conta.

## Rodando localmente

```
cp .env.example .env
# preencher DATABASE_URL (Postgres local) e PLATFORM_URL (kyvvo-platform rodando local ou em produção)
npm install
npm start
```

## Testes

```
npm test
```

## Estrutura

- `index.js` — servidor Fastify, todas as rotas sob `/crm`.
- `lib/db.js` — pool Postgres + migration runner (`@kyvvohq/db-migrate`, aplica `db/*.sql`).
- `lib/clientes.js` — achar-ou-criar cliente por telefone (E.164), métricas calculadas.
- `lib/etapas.js` — modelo de segmento "Produção sob encomenda" (etapas padrão do onboarding).
- `lib/telefone.js` — normalização E.164 (idêntico ao kyvvo-people).
- `db/` — schema (clientes, pedidos/kanban, tags, campos customizados, eventos, segmentos, formulários, sorteios, importações).
- `docs/` — decisões pendentes e backlog da Fase 1, a partir do doc de instruções do projeto.

## Escopo (Fase 1 / MVP)

Implementado neste scaffold inicial: auth, clientes (CRUD + busca + métricas + timeline), pedidos em kanban (criação rápida, mover etapa, pagamento), Painel Hoje.

Ainda não implementado (backlog, ver `docs/backlog-fase1.md`): importação (UpSeller/NF-e/CSV), formulário de captação público, segmentos salvos + sorteio, frontend (kanban visual, ficha do cliente, painel hoje).
