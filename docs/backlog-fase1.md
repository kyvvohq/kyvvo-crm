# Backlog — Fase 1 (MVP)

A partir da seção 7 do doc de instruções do projeto. Formato pronto pra colar
no Notion assim que a database for escolhida (docs/DECISOES-PENDENTES.md #5).
Cada história aponta se já tem API implementada neste scaffold — falta
sempre o frontend.

## Clientes

- [x] API: listar clientes com busca (nome/telefone/CPF).
- [x] API: criar cliente manualmente.
- [x] API: editar cliente.
- [x] API: ficha do cliente (dados, tags, campos customizados, métricas
      calculadas, pedidos, timeline completa).
- [ ] Frontend: lista + busca + filtros.
- [ ] Frontend: ficha do cliente.
- [ ] API + frontend: criar/gerenciar tags.
- [ ] API + frontend: criar/gerenciar campos customizados por conta.
- [ ] API: sugestão de mesclagem por CPF ou nome+cidade (mesclagem sempre
      confirmada por humano — nunca automática).

## Pedidos / kanban

- [x] API: listar pedidos (kanban).
- [x] API: criação rápida (telefone acha-ou-cria cliente, itens/descrição,
      valor, origem, tipo de entrega).
- [x] API: mover etapa (exige motivo quando etapa é "perdida").
- [x] API: atualizar status de pagamento / valor recebido (paralelo à etapa).
- [ ] Frontend: kanban com colunas configuráveis, drag-and-drop.
- [ ] Card do pedido: sinalização visual de "passou do prazo da etapa".
- [ ] Aviso de "incluir cartão de recompra no kit" pra pedidos de origem
      própria (nunca marketplace — restrição Shopee, seção 9 do doc).
- [ ] API + frontend: CRUD de etapas (config por conta).
- [ ] API + frontend: CRUD de produtos.

## Importação

- [ ] Importar exportação de pedidos do UpSeller (Excel) — mapeamento de
      colunas + preview. Bloqueado por docs/DECISOES-PENDENTES.md #6
      (colunas reais ainda não confirmadas).
- [ ] Importar XML de NF-e — enriquece pedido existente por número do
      pedido; cria novo só se não achar correspondência.
- [ ] Importar CSV/Excel genérico (planilhas antigas, respostas de Google
      Forms).
- [ ] Todas idempotentes: reimportar mesmo arquivo/número de pedido/chave de
      NF-e não duplica (já garantido no schema por índices únicos parciais
      em `crm_pedidos`).

## Formulário de captação

- [ ] API: criar formulário (campos escolhidos pela conta).
- [ ] Página pública do formulário, com aceite de comunicação obrigatório.
- [ ] Tag automática por formulário respondido.
- [ ] Aplica a regra de identidade (mesmo dedupe por telefone dos clientes).

## Segmentos e sorteio

- [ ] API + frontend: montar segmento (filtros combináveis: tag, campo
      customizado, cidade, origem, produto comprado, período de compra, dias
      sem comprar, aniversário no mês, status de pagamento, consentimento).
- [ ] Salvar segmento, exportar CSV.
- [ ] Botão "Sortear": congela participantes, sorteia, registra vencedor e
      ator (auditável) — schema já pronto (`crm_sorteios`).

## Painel Hoje

- [x] API: o que produzir / orçamentos parados / pagamentos pendentes /
      prontos pra envio / aniversariantes do dia.
- [ ] Frontend: tela inicial.
- [ ] Botão de WhatsApp por item (link wa.me com mensagem pronta a partir de
      `crm_modelos_mensagem`) — sem disparo automático no MVP.
- [ ] API + frontend: CRUD de modelos de mensagem.

## Onboarding

- [x] Modelo de segmento único "Produção sob encomenda" (config da Basic),
      inicializado automaticamente no primeiro login de um tenant novo
      (`lib/etapas.js`).
- [ ] Frontend do onboarding (hoje é 100% automático/invisível — falta se o
      produto quiser deixar o dono escolher/editar antes de começar a usar).

## Critérios de sucesso com a Basic (30–45 dias, seção 7.7)

- [ ] Nauara usa o Painel Hoje no lugar das etiquetas do WhatsApp.
- [ ] Todo pedido direto (WhatsApp, retirada, entrega local) registrado no
      CRM.
- [ ] Sorteio mensal sai de um segmento, sem planilha.
- [ ] Orçamentos parados recuperados pelo follow-up do painel.

Nenhum desses é alcançável sem frontend — é o gargalo real pra validar com a
Basic, mais do que qualquer rota de API que falte.
