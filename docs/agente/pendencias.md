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

## Marco 3 — concluído
Migration 036; `lib/agente/{posfiltro,horario,ferramentas,contexto,executor}.js`; base de conhecimento higienizada em `docs/basic/conhecimento/*.md` (originais intactos em `fontes/`) carregada pelo seed; `@anthropic-ai/sdk` adicionado. Testes em `test/agente-executor.test.js` (modelo mockado, sem rede).
- `anexar_midia` não é ferramenta do modelo: o código anexa imagens/documentos ao pedido rascunho e abre o encaminhamento `arquivo_recebido`, sem avaliar viabilidade (o modelo só vê "[imagem recebida e anexada]").
- `enviarTexto` (@kyvvohq/whatsapp) devolve só true/false, sem `wamid`: mensagens do agente ficam sem `wamid` e não recebem atualização de status de entrega. Se quisermos status/cobrança por mensagem enviada, o módulo compartilhado precisa devolver o id.
- Rascunho de pedido aparece no quadro como qualquer pedido da etapa inicial (`crm_pedidos.rascunho = true`); falta decidir o gesto "revisado" que limpa a flag (marco 5).
- Pós-filtro é deliberadamente estrito (bloqueia até a palavra "frete" na boca do agente): o custo é um encaminhamento a mais; acompanhar a taxa de bloqueio nos evals.
- Rate limit por número e retenção de logs ainda não implementados (marco 6).
- Modelo padrão `claude-haiku-4-5`; `claude-haiku-5-5` entra na comparação do marco 4.

## Marco 4 — concluído (parcial: falta a rodada real)
`evals/` (carregador, avaliador, executor, CLI), 25 casos (6 do doc 04 + 19 adversariais) e `npm run evals`; `test/evals.test.js` roda a suíte em modo mock no `npm test`. Carregador de `evals/basic/` pronto (vazio até chegarem as conversas anonimizadas).
- **A comparação Haiku 4.5 × 5.5 ainda não foi rodada**: precisa de `ANTHROPIC_API_KEY` e `npm run evals -- --real --modelos claude-haiku-4-5,claude-haiku-5-5`. Até lá, `modelo_runtime` segue `claude-haiku-4-5`.
- Batch API não é usada: cada caso é um laço de ferramentas com várias idas e voltas.
- Os preços por modelo em `evals/cli.js` (`PRECOS`) são os vigentes em 2026-10; conferir antes de decidir por custo.
