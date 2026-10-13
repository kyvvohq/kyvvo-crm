# Runbook — conectar o número da Basic 3D Print ao agente de atendimento

Número: **+55 34 95330-1392**. O onboarding na Meta é **manual** e fica fora do código: nada aqui registra o número nem chama a API de produção da Meta. O código só consome o que a Meta entregar (webhook encaminhado pelo kyvvo-platform) e envia pela Cloud API com o `phone_number_id` cadastrado.

> Fatos sobre coexistência e cobrança abaixo vêm de documentação de parceiros da Meta e de resumos de mercado (out/2026). **Confirme na documentação oficial da Meta antes de executar** — itens marcados com ⚠️ são os que mais mudam.

## 0. Decisão que precisa ser tomada antes (pendência aberta)

O número é o WhatsApp Business app atual da Basic ou um chip novo?

| | **Coexistência** (mantém o app) | **Só API** (número migrado ou novo) |
|---|---|---|
| Quem responde | A equipe continua no app **e** o agente responde pela API | Tudo pela API: a equipe usa a tela **Atendimento** do CRM |
| Histórico | Pode sincronizar o histórico de conversas e contatos no onboarding (⚠️ prazo de sincronização de ~24 h após conectar; senão refazer) | Começa do zero (ou migração com perda do app) |
| Mensagens enviadas pelo app | Chegam ao CRM como **eco** (`smb_message_echoes`) — o código marca a conversa como `humano` e pausa o agente | Não existe eco: equipe responde pelo CRM (assumir/responder) |
| Cobrança | Mensagens enviadas **pelo app** não são cobradas; as da API seguem o preço da Meta | Todas pela API, cobradas conforme a categoria |
| Limites | ⚠️ Taxa máxima de ~20 mensagens/s (não aumenta); sem selo azul oficial; listas de transmissão do app ficam só leitura | Sem esses limites |
| Eco abre janela de 24 h? | **Não**: só mensagem da cliente abre a janela para resposta livre | — |

Recomendação: **coexistência**, porque a equipe mantém o fluxo de hoje e o agente entra de forma gradual. O código já trata o eco (pausa o agente 12 h por padrão, `limites.pausa_humano_horas`).

## 1. Pré-requisitos (Meta)

1. Conta no Meta Business Manager da Basic com **verificação do negócio** concluída.
2. App da Kyvvo (Tech Provider) com o produto WhatsApp e o **Embedded Signup** habilitado. O kyvvo-platform recebe o webhook da Meta (o CRM nunca é aberto para a Meta direto) e encaminha para `POST /crm/api/webhook/whatsapp` com o header `x-webhook-internal-secret`.
3. No app do celular (coexistência): WhatsApp Business atualizado; manter o app em uso (⚠️ a Meta desconecta a coexistência se o app ficar muito tempo sem abrir).
4. Campos de webhook assinados no app da Meta: `messages` (mensagens e status) e, para coexistência, `smb_message_echoes` (+ `history` e `smb_app_state_sync` se quiser histórico e contatos). O CRM trata `messages` e `smb_message_echoes`.

## 2. Conectar o número (manual, na tela do CRM ou do admin)

1. Fazer o **Embedded Signup** (tela *Configurações > WhatsApp* do CRM, `lib/meta-whatsapp-service.js`) escolhendo coexistência ou número só API.
2. Anotar o `phone_number_id` e o `waba_id` devolvidos.
3. Vincular o número ao tenant da Basic (um dos dois):
   - kyvvo-admin → vínculo de número (`/crm/admin-interno/whatsapp-numeros`), ou
   - `node scripts/seed-agente.js --tenant <TENANT_ID_BASIC> --phone-number-id <ID> --numero "+55 34 95330-1392" --canal-modo coexistencia` (ou `api`).
   O seed **não liga** o agente: `modo` fica `desligado` por padrão.
4. Conferir `select phone_number_id, tenant_id, modo, status from crm_whatsapp_numeros;`.

## 3. Variáveis de ambiente do serviço

`DATABASE_URL`, `PLATFORM_URL`, `ADMIN_INTERNAL_TOKEN`, `WEBHOOK_INTERNAL_SECRET` (mesmo valor configurado no kyvvo-platform), `META_WHATSAPP_TOKEN` (envio e download de mídia), `ANTHROPIC_API_KEY`, opcional `AGENTE_MIDIA_MAX_BYTES`. Segredos em AWS SSM `/kyvvo/crm/<KEY>` (ainda não configurado para este serviço — ver CLAUDE.md).

## 4. Configurar o agente da Basic

```powershell
node scripts/seed-agente.js --tenant <TENANT_ID_BASIC> --modo rascunho
```
Carrega `db/seeds/basic.json` (horário 8h–18h America/Sao_Paulo, quantidade padrão por categoria, textos fixos, campos do briefing) e a base de conhecimento higienizada (`docs/basic/conhecimento/*.md`). Reexecutar é seguro (idempotente; conhecimento muda → nova versão).
Ajustes por conta ficam em `crm_agente_config` (`limites.max_turnos`, `limites.max_msgs_por_hora`, `limites.teto_diario_tokens`, `limites.pausa_humano_horas`, `limites.tempo_alvo_resposta_min`, `limites.custo_mensagem_meta_usd`, `retencao_logs_dias`).

## 5. Entrada em produção — gradual

1. **Antes de ligar:** rodar os evals reais (`npm run evals -- --real`) e conferir ≥ 90% (última medição: 96% com `claude-haiku-5-5`).
2. **Modo `rascunho`** (padrão): o agente só sugere; a equipe aprova em *Atendimento*. Ficar assim por pelo menos 1–2 semanas e acompanhar os indicadores: taxa de sugestões aprovadas sem edição, taxa de filtro acionado, tempo até a 1ª resposta humana.
3. **Teste ponta a ponta com um número de teste** (não cliente real): mandar texto, imagem, áudio, "quanto custa?", "quero falar com atendente" e conferir sugestão, anexo, encaminhamento no Painel Hoje.
4. Só então considerar `automatico` (a tela pede confirmação). Mesmo no automático valor, prazo e frete continuam sempre com a equipe (filtro em código).

## 6. Desligar / reverter (chave de desligamento)

- **Tela Atendimento → seletor "Agente" → Desligado**, ou `update crm_agente_config set modo = 'desligado' where tenant_id = '<TENANT>';`.
- Efeito imediato: novas mensagens voltam para o bot antigo por lista; turnos pendentes não geram resposta; conversas em andamento ficam como estão (a equipe responde pela tela ou pelo app).
- Testado em `test/agente-metricas.test.js` (chave de desligamento).

## 7. Operação diária

- **Painel Hoje → "Falar hoje — encaminhados pelo agente"** é a fila de quem precisa de resposta (VIP primeiro).
- Se a equipe responde pelo app (coexistência), o eco pausa o agente sozinho; pela tela, **Assumir** ou responder pausa; **Devolver ao agente** reativa.
- Alertas em *Atendimento → Indicadores*: teto diário a 80%/100%, fila parada além do tempo-alvo, muitos bloqueios do filtro.

## 8. Custos (⚠️ confirmar no rate card oficial)

- **IA:** tokens por turno, medidos por execução (`crm_agente_execucoes`); preço por modelo em `lib/agente/precos.js`. `claude-haiku-5-5` custou cerca de US$ 0,05 para a suíte de 24 casos.
- **Meta:** a partir de **1º/out/2026** mensagens de serviço dentro da janela de 24 h passam a ser cobradas (antes eram gratuitas); fontes divergem sobre existir franquia mensal gratuita por número (⚠️ não confirmado). Por isso a observabilidade conta as mensagens enviadas por categoria; quando o valor oficial por mensagem for conhecido, definir `limites.custo_mensagem_meta_usd` para ver o custo estimado.
- O agente **não envia mensagens ativas** (nenhum template): só responde dentro da janela de 24 h.

## 9. Checklist de aceite do go-live

- [ ] Verificação do negócio e Embedded Signup concluídos; `crm_whatsapp_numeros` correto.
- [ ] Webhook encaminhado pelo kyvvo-platform com o segredo certo; mensagem de teste aparece em *Atendimento*.
- [ ] `ANTHROPIC_API_KEY` e `META_WHATSAPP_TOKEN` configurados; envio de uma sugestão aprovada chega ao celular de teste.
- [ ] Eco do app (coexistência) pausa o agente; payload real do `smb_message_echoes` conferido (campo `message_echoes[]`).
- [ ] Teto diário e tempo-alvo definidos em `crm_agente_config.limites`; retenção de logs definida (`docs/agente/lgpd.md`).
- [ ] Equipe sabe: onde ver a fila, como assumir/devolver, como desligar.
