---
name: diagnosticar-bot-whatsapp
description: Runbook pra "bot de atendimento do CRM não responde" (ou responde errado) para um tenant específico. Usa o toolkit de diagnóstico admin-interno construído em 2026-10-13 (kyvvo-crm#141-#151, kyvvo-admin#68-#74, kyvvo-platform#46) para percorrer, em ordem causal, as 5 camadas que já causaram esse sintoma em produção: roteamento do platform, segredo do webhook, inscrição da WABA na Meta, bug de injeção de dependências no agente, e números de telefone duplicados. Use sempre que o usuário disser algo como "o bot não responde", "o agente não está respondendo", "mensagem travada" ou "cliente mandou e não teve resposta" para o CRM.
---

# Diagnosticar bot de atendimento do CRM (WhatsApp)

Runbook construído ao vivo em 2026-10-13 depurando o bot da Basic 3D Print
(phone_number_id 1350077118193420). Encontrou e corrigiu 5 bugs
independentes e empilhados — qualquer um sozinho já bastava pra causar
"bot não responde". Siga NA ORDEM: cada camada só faz sentido checar se a
anterior está OK.

Pré-requisito: um token de admin válido (`localStorage.getItem('kyvvo_admin_token')`
no browser logado em admin.kyvvo.com.br, ou pedir pro usuário). Todas as
chamadas abaixo são `fetch` autenticadas com `Authorization: Bearer <token>`
contra o kyvvo-admin (que repassa pro kyvvo-crm/kyvvo-platform via proxy
interno — nenhuma chamada direta ao banco é necessária).

## Passo 0 — identificar o tenant e o número

Pergunte (ou descubra) o `tenant_id` (uuid) e o `phone_number_id` em
questão. Se só tiver o nome da conta, use
`GET /api/whatsapp/crm-tenants` (lista tenants com módulo `crm` ativo).

## Passo 1 — canal e modo do agente

```js
GET /api/whatsapp/crm-diagnostico/:tenantId
```

Retorna `canais` (linhas de `crm_whatsapp_numeros` pro tenant — **confira
se há mais de UMA linha com `status: 'ativo'`**, isso sozinho já é bug,
ver Passo 5), `mensagens_recentes`, `conversas_recentes` e
`execucoes_recentes` (de `crm_agente_execucoes`).

- Nenhuma linha em `canais` → o número nunca foi vinculado a este tenant
  (usar a tela "Kyvvo CRM — WhatsApp por cliente" no admin pra vincular).
- `modo` != `automatico` → agente não vai responder sozinho por design,
  não é bug. Trocar via `PATCH /api/whatsapp/crm-agente-config/:tenantId`
  (`{modo: "automatico"}`) se for isso que o usuário quer.
- `mensagens_recentes` vazio (cliente mandou mensagem e nada aparece
  aqui) → vá pro Passo 2, o problema é antes de chegar no CRM.
- `execucoes_recentes` vazio mas `mensagens_recentes` tem a mensagem do
  cliente → o turno do agente está travando ANTES do primeiro
  `registrarExecucao` (ver Passo 4).

## Passo 2 — a Meta sequer mandou o evento pra gente?

```js
GET /internal/whatsapp/eventos?pnid=<phone_number_id>  (via kyvvo-platform, token "admin")
```

Essa rota é no kyvvo-platform (único destino cadastrado na Meta — ver
[[project_kyvvo_whatsapp_webhook_router]]), não no kyvvo-admin. Zero
linhas aqui pra um número que devia estar recebendo mensagem = ou a WABA
não está inscrita no app (Passo 3), ou o `phone_number_id` não é o que
você pensa (confira o número exibido vs o cadastrado).

## Passo 3 — a WABA está inscrita no webhook da Meta?

A Meta permite uma WABA estar CONNECTED/APPROVED e **nunca** ter o app
Kyvvo inscrito nos webhooks dela — falha silenciosa, separada do
Embedded Signup.

```js
GET  /api/whatsapp/wabas/:wabaId/inscricao-webhook   // lista inscrições
POST /api/whatsapp/wabas/:wabaId/inscricao-webhook   // inscreve de novo
```

Se a lista vier vazia ou sem o app da Kyvvo, rode o POST. (O campo
`inscrito` devolvido pode vir `false` por engano se `META_APP_ID` não
bater com o ID numérico do app — isso é cosmético, confie na lista bruta
de inscrições, não só no boolean.)

## Passo 4 — reprocessar e ver o erro real

Mensagem chegou (Passo 1 mostra em `mensagens_recentes`) mas
`execucoes_recentes` está vazio ou sem `tem_enviada: true`? Teste a
chave da Anthropic primeiro, depois reprocesse:

```js
GET  /api/whatsapp/crm-testar-anthropic
POST /api/whatsapp/crm-reprocessar/:tenantId/:telefone
```

O reprocessar reseta `tentativas` E `processada_em` da última mensagem
do cliente e roda o turno de novo de verdade — qualquer exceção real
(ex. `TypeError: d.agora is not a function`, do bug de 2026-10-13) sai
no corpo da resposta, não fica só num `console.error` engolido. Depois,
repita o Passo 1 (`crm-diagnostico`) pra confirmar `tem_enviada: true`.

Se o erro for sobre uma dependência faltando num objeto `deps`/`overrides`
em `lib/agente/*.js`, isso é a classe de bug do PR #149/#150 — ver o
subagent [[agente-deps-reviewer]] deste mesmo repo antes de corrigir na
mão.

## Passo 5 — número duplicado causando envio pelo canal errado

`processadas: 1` mas `tem_enviada: false` sem erro explícito, ou
`execucoes_recentes` mostra sucesso mas a mensagem nunca chega no
celular real → confira se há MAIS de uma linha `status: 'ativo'` em
`crm_whatsapp_numeros` pro mesmo tenant (Passo 1). `numeroDoCanal()` em
`lib/agente/executor.js` escolhe `order by criado_em limit 1` — ou seja,
a linha MAIS ANTIGA, que pode ser a duplicata errada. Remova a duplicata:

```js
DELETE /api/whatsapp/crm-numeros/:phoneNumberIdErrado
```

Confirme com o usuário qual número é o certo antes de deletar — essa é
uma ação destrutiva sobre dado real de cliente, não é reversível pela UI.

## Depois de corrigir

Peça uma mensagem de teste NOVA vinda do celular real do cliente (não só
o reprocessamento do Passo 4) — o reprocessar nunca valida a entrega de
volta pro WhatsApp do cliente, só o lado do CRM/agente. Esse é o único
jeito de confirmar o pipeline inteiro (Meta → platform → CRM → agente →
Meta → celular) de ponta a ponta.
