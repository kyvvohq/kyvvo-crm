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
- Assinatura `X-Hub-Signature-256` validada no kyvvo-platform (a Meta só fala com ele); o CRM mantém `x-webhook-internal-secret`. **Aguardando confirmação.**
- Fila em Postgres no lugar de SQS FIFO e S3 via variáveis de ambiente na v1; infra AWS vai para o `kyvvo-infra`. **Aguardando confirmação.**
- Conversa/mensagem estendem `crm_conversas_whatsapp` / `crm_mensagens_whatsapp`. A situação do atendimento é `situacao` (e não `estado`, que já é o passo do bot por lista).
- Retenção de logs (`crm_agente_config.retencao_logs_dias`): sem expurgo automático ainda; definir prazo por conta (LGPD).

## Marco 1 — concluído
Migrations 031–034, seed (`db/seeds/basic.json` + `scripts/seed-agente.js`), `test/agente-schema.test.js`. O seed deixa `modo = desligado` por padrão; ligar com `--modo rascunho`.
