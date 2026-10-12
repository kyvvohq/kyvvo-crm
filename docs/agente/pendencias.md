# Agente de IA — pendências

Atualizada ao fim de cada marco. Origem: `docs/basic/prompt-agente.md`.

## Do spec
- Decisão 14 ambígua: confirmar com a Nauara o que significa "leitura de TAG VIP" para a foto no grupo. Padrão: `registrar_autorizacao_imagem`; sem autorização registrada, a foto não é postada.
- Decisão 10 sem resposta: padrão adotado (registrar o ID Shopee e marcar "aguardando conferência"). Frequência de exportação do UpSeller desconhecida.
- Quem recebe os encaminhamentos, tempo-alvo de resposta e dias de atendimento (`horario_atendimento.dias = null` = todos os dias até definir).
- Número +55 34 95330-1392: confirmar se é o WhatsApp Business atual (coexistência) ou chip novo (`crm_whatsapp_numeros.modo`).
- Valores de cobrança da Meta para mensagens de serviço: confirmar no rate card oficial antes de fixar tetos de custo.
- Base de produtos e tabelas de preço/frete: entram como novas ferramentas, em outro marco.

## Do plano (decisões que mudaram o spec)
- `conta_id` → `tenant_id` (DECISOES-PENDENTES #1).
- Assinatura `X-Hub-Signature-256` validada no kyvvo-platform (a Meta só fala com ele); o CRM mantém `x-webhook-internal-secret`. **Confirmado: fica no platform.**
- Sem SQS e sem tabela de fila: a própria `crm_mensagens_whatsapp` é a fila (`processada_em` nulo), com lock por conversa e varredura a cada 60 s (confirmado).
- Mídia segue em disco (`uploads/agente/<tenant_id>/...`, decisão de 2026-09-24 de não abrir infra externa) atrás da interface `lib/armazenamento.js`; driver S3 fica para quando houver infra no `kyvvo-infra`.
- Conversa/mensagem estendem `crm_conversas_whatsapp` / `crm_mensagens_whatsapp`. A situação do atendimento é `situacao` (e não `estado`, que já é o passo do bot por lista).
- Retenção de logs (`crm_agente_config.retencao_logs_dias`): sem expurgo automático ainda; definir prazo por conta (LGPD).

## Marco 1 — concluído
Migrations 031–034, seed (`db/seeds/basic.json` + `scripts/seed-agente.js`), `test/agente-schema.test.js`. O seed deixa `modo = desligado` por padrão; ligar com `--modo rascunho`.

## Marco 2 — concluído
Migration 035, `lib/agente/{entrada,recebimento,processador,index}.js`, `lib/armazenamento.js`, `baixarMidia` em `lib/whatsapp-media.js`, roteamento no webhook (número com `crm_agente_config.modo <> 'desligado'` vai para o agente; os demais seguem no bot por lista). Testes em `test/agente-webhook.test.js`.
- Conferir contra payload real: nome do campo do eco de coexistência (`smb_message_echoes`) e `message_echoes[]`.
- Pausa após resposta humana: `limites.pausa_humano_horas` (padrão 12 h) — definir com a conta.
- Limite de mídia 20 MB (`AGENTE_MIDIA_MAX_BYTES`); STL maior que isso é recusado e registrado em `midia.erro`.
- Perguntar ao time do platform: ele espera o 200 do CRM antes de responder à Meta?
