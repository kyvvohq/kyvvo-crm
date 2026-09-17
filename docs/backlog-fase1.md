# Backlog — Fase 1 (MVP)

A partir da seção 7 do doc de instruções do projeto. **Fonte de verdade agora
é [kyvvohq/kyvvo-crm/issues](https://github.com/kyvvohq/kyvvo-crm/issues)** —
este arquivo é só um índice rápido, não duplique detalhe aqui.

## Entregue (issues fechadas #1–#14)

Login/cadastro/landing, clientes (CRUD + ficha + segmento), pedidos (criação
rápida + kanban + pagamento), quadro de etapas editável, raias de produção
(recursos), máscara de moeda/campos obrigatórios, Painel Hoje.

## Em aberto (issues #15–#29)

- **Clientes**: tags (#15), campos customizados (#16), sugestão de mesclagem (#17).
- **Pedidos**: catálogo de produtos (#18), sinalização de prazo (#19), aviso de cartão de recompra (#20).
- **Importação**: UpSeller/NF-e/CSV (#21) — bloqueada em parte por dados reais da Basic (ver `DECISOES-PENDENTES.md` #6).
- **Formulário de captação** (#22).
- **Segmentos e sorteio**: segmentos salvos (#23), sorteio (#24).
- **Mensagens**: modelos de mensagem (#25).
- **Onboarding visível** (#26).
- **Débito técnico**: trocar `prompt()` nativo por modal (#27), flag explícito de etapa "pronta" (#28).
- **Decisão bloqueada**: plano/preço/billing do módulo CRM (#29).

## Critérios de sucesso com a Basic (30–45 dias, seção 7.7 do doc)

- [x] Painel Hoje no lugar das etiquetas do WhatsApp (existe; falta uso real).
- [x] Pedido direto registrável no CRM (existe; falta uso real).
- [ ] Sorteio mensal sai de um segmento, sem planilha — depende de #23 e #24.
- [ ] Orçamentos parados recuperados pelo follow-up do painel — depende de uso real.
