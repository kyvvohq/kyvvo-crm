# Evals do agente de atendimento

Mede o agente de ponta a ponta com o mesmo código de produção (`executarTurno`: prompt, ferramentas, pós-filtro, handoffs) contra um tenant descartável no banco local.

```powershell
$env:DATABASE_URL = "postgres://user:pw@localhost:5432/kyvvo_crm_test"
npm run evals                                              # mock: sem rede e sem custo
$env:ANTHROPIC_API_KEY = "sk-ant-..."
npm run evals -- --real                                    # modelo da config (claude-haiku-4-5)
npm run evals -- --real --modelos claude-haiku-4-5,claude-haiku-5-5   # comparação
npm run evals -- --real --casos adv-audio,adv-id-shopee   # só alguns casos
```

O relatório (tabela por modelo: aprovação, filtro acionado, encaminhamentos, tokens, latência, custo) vai para `evals/resultados/` (ignorado pelo git). O banco precisa ser local; `EVALS_PERMITIR_BANCO_REMOTO=1` libera outro.

## Dois modos, dois propósitos
- **mock** (padrão, roda no `npm test`): um "modelo" roteirizado em cada caso (`mock`). Não mede o Claude; prova que a suíte, as ferramentas, o pós-filtro e a correção funcionam, e que a rede de proteção em código segura um modelo que ceda (`adv-injecao-modelo-vaza-preco`).
- **`--real`** (flag explícita, gasta tokens): ignora os roteiros e mede o modelo de verdade. É aqui que se decide entre as versões de Haiku.

## Como ler o resultado real
- *Passaram*: expectativas determinísticas do caso (`evals/avaliar.js`), mais invariantes em todo caso (nada de valor/prazo/frete/pagamento/estoque, sem nome de pessoa, resposta curta).
- *Filtro acionado*: quantas vezes o modelo tentou dizer algo proibido e o pós-filtro trocou pelo encaminhamento. A cliente nunca vê o texto original, mas cada acionamento é um encaminhamento a mais para a equipe: quanto menor, melhor.
- Escolha do modelo: menor taxa de falhas e de filtro acionado primeiro; custo e latência desempatam.

## Adicionar casos
JSON em `evals/casos/` (casos do projeto) ou `evals/basic/` (conversas reais anonimizadas da Basic). Formato e campos de `esperado` documentados em `evals/carregador.js` e `evals/avaliar.js`. Casos sem `mock` só rodam com `--real`.
Anonimize antes de commitar: sem nome, telefone, CPF, endereço ou ID de pedido reais.
