# Agente de IA — pendências

> **Numeração das migrations:** após o merge com a master (que ganhou 030–034 enquanto esta branch era desenvolvida), as migrations do agente foram renumeradas de 031–038 para **035–042**. Onde este documento diz "migration 031–034" leia 035–038; 035→039; 036→040; 037→041; 038→042.

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

## Marco 4 — rodada real nº 1 (2026-10-13) e ajustes
Resultado: `claude-haiku-4-5` 9/24 (US$ 0,25), `claude-haiku-5-5` 15/24 (US$ 0,05, ~5× mais barato). Falhas dominantes: o modelo prometia "vou encaminhar"/"anotei" sem chamar a ferramenta; o filtro agia em 8/24 casos (palavras como frete/disponível na boca do modelo); 3 casos do eval estavam mal desenhados.
Ajustes feitos: prompt `sistema.md` reescrito (regras de ferramenta, palavras proibidas até para negar, frase VIP exata, aviso fora do horário); rede de proteção em código (promessa de encaminhar sem handoff cria o handoff; aviso de fora do horário acrescentado 1× por período); migration 037 guarda o texto original do modelo bloqueado (`resposta_original`); relatório de evals lista os bloqueios com o texto original; casos `doc04-2/4/6` corrigidos. **Falta rodar a rodada real nº 2** para confirmar a melhora e escolher o modelo.

### Rodada real nº 2 (2026-10-13 01:52) e novos ajustes
`claude-haiku-4-5` 11/24 (46%), 0 bloqueios, US$ 0,27 · `claude-haiku-5-5` 18/24 (75%), 2 bloqueios, US$ 0,05. O 4.5 raramente chama `registrar_briefing` (diz "anotei" sem registrar); o 5.5 chama bem, mas ainda esquecia `transferir_para_equipe` e `registrar_id_shopee`.
Ajustes: `lib/agente/gatilhos.js` — o código lê a mensagem da cliente e garante o handoff nos gatilhos obrigatórios (pedido de pessoa, produto danificado/diferente, reclamação, atraso, andamento, urgência, desconto/negociação; valor/prazo/frete/pagamento só depois de haver produto + quantidade) e registra o ID Shopee quando o modelo não registra; cliente é avisada em uma frase (`textos.equipe_avisada`). Casos de eval relaxados onde o spec manda coletar o briefing antes de encaminhar (pagamento, envio). Testes do executor agora usam relógio fixo.
Recomendação provisória: `modelo_runtime = claude-haiku-5-5` (mais acertos e ~5× mais barato). A decisão final depende da rodada real nº 3.

### Rodada real nº 3 (2026-10-13 02:00) e decisão de modelo
`claude-haiku-4-5` 17/24 (71%), US$ 0,28 · `claude-haiku-5-5` 21/24 (88%), US$ 0,05. **Padrão passa a `claude-haiku-5-5`** (migration 038 + seed). Falhas do 5.5: `adv-id-shopee` era artefato do eval (mesmo tenant para os dois modelos — agora cada modelo roda em tenant próprio); `adv-urgencia` e `doc04-3` tiveram a resposta bloqueada por o modelo repetir o "amanhã" da cliente (filtro agora só barra "amanhã" ligado a promessa) e o bloqueio sobrescrevia o motivo do handoff (agora preserva).
Falta a rodada nº 4 só com o 5.5 para confirmar ≥ 90%.

### Rodada real nº 4 (2026-10-13) — marco 4 encerrado
`claude-haiku-5-5`: 96% dos casos. Modelo padrão confirmado.

## Marco 5 — concluído
`lib/agente/atendimento.js` + rotas `/crm/api/agente/*` (config/liga-desliga, conversas, sugestões, assumir, responder, devolver, encerrar, anexos, resumo) e `POST /crm/api/pedidos/:id/revisado`; tela `public/atendimento.html` (lista por situação com o encaminhamento em destaque, thread com anexos, sugestão do agente com Enviar/Editar/Descartar, assumir/devolver, resposta pela equipe, chave do agente); card "Falar hoje — encaminhados pelo agente" no Painel Hoje; item "Atendimento" com contador no menu (injetado pelo `shell.js` em todas as telas). Testes: `test/agente-atendimento.test.js`.
- Decisão de cada sugestão (aprovada / editada / descartada) fica em `crm_agente_execucoes.decisao` — base para medir qualidade no marco 6.
- Assumir/responder pelo CRM deixa a conversa em `humano` (agente em silêncio) até "Devolver ao agente"; o eco do app (coexistência) pausa por `limites.pausa_humano_horas`.
- Sem papéis no CRM: qualquer usuário da conta vê e age nas conversas; qualquer um pode trocar o modo do agente (ligar "Responde sozinho" pede confirmação).
- Interface conferida no navegador com dados fictícios (Painel Hoje e Atendimento, desktop). Não testada em celular nem com o `@kyvvohq/design-system` instalado localmente (usei os arquivos publicados em /ds/).
- Resposta da equipe e aprovação enviam só texto; envio de arquivos/imagens pela equipe não existe.

## Marco 6 — concluído
Observabilidade (`lib/agente/metricas.js`, `GET /crm/api/agente/metricas`, card "Indicadores" em Atendimento): custo da IA (tokens x preço por modelo, `lib/agente/precos.js`) e mensagens enviadas por categoria da Meta, custo por conversa, taxa de bloqueio do filtro, qualidade das sugestões, tempo até a 1ª resposta humana, fila aberta, uso do teto diário e alertas (teto 80%/100%, fila parada além de `limites.tempo_alvo_resposta_min`, muitos bloqueios). Rate limit por número da cliente (`limites.max_msgs_por_hora`, padrão 30). Retenção de logs (`retencao_logs_dias`, expurgo a cada 6 h; `null` não apaga). Chave de desligamento testada (webhook volta ao bot antigo; turno pendente não responde). Runbook `docs/runbooks/onboarding-whatsapp-basic.md`, `docs/agente/lgpd.md`, CLAUDE.md atualizado. Testes: `test/agente-metricas.test.js`.

## Pendências finais (consolidadas)
**Dependem de você / da Basic**
1. Decisão 14: o que significa "leitura de TAG VIP" para postar a foto no grupo VIP (hoje: `registrar_autorizacao_imagem` existe como regra de dados, **o agente ainda não tem essa ferramenta exposta ao modelo** — só entra quando a equipe definir o fluxo).
2. Decisão 10: frequência da exportação do UpSeller (a importação deve enriquecer o pedido Shopee rascunho pelo mesmo `identificador_externo`; **não testado com a importação real**).
3. Quem recebe os encaminhamentos, tempo-alvo (`limites.tempo_alvo_resposta_min`) e dias de atendimento (`horario_atendimento.dias`, hoje todos os dias).
4. Número +55 34 95330-1392: coexistência ou chip novo.
5. Valor oficial da Meta por mensagem (e se há franquia de serviço desde 1/10/2026) → `limites.custo_mensagem_meta_usd`.
6. Prazo de retenção de logs (`retencao_logs_dias`; sugestão 90 dias) e DPA com o fornecedor da IA.
7. Conversas reais anonimizadas da Basic em `evals/basic/`.

**Técnicas**
- Conferir com payload real: `smb_message_echoes` / `message_echoes[]` (nome do campo confirmado por documentação de parceiros, não pela Meta).
- Perguntar ao time do platform se ele espera o 200 do CRM antes de responder à Meta.
- `enviarTexto` do `@kyvvohq/whatsapp` não devolve `wamid`: mensagens do agente não recebem status de entrega/categoria de cobrança (custo da Meta fica "sem categoria" até o módulo devolver o id).
- Sem papéis no CRM (qualquer usuário da conta vê/age e liga/desliga o agente); resposta da equipe só em texto.
- Rotina de exclusão/anonimização do titular para mensagens, anexos e conversas do agente (LGPD).
- Infra: S3 para anexos e SQS só se o volume pedir; segredos no SSM ainda não configurados para este serviço.
- Base de produtos, preços e frete: entram como novas ferramentas, em outro marco (ponto de extensão em `lib/agente/ferramentas.js`).
