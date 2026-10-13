// Preço por modelo, US$ por 1 milhão de tokens [entrada, saída]. Tabela vigente em 2026-10; conferir antes de
// decidir por custo. Tokens de cache entram como entrada normal (estimativa conservadora, um pouco acima do real).
const PRECOS_USD_POR_MTOK = {
  'claude-haiku-4-5': [1.0, 5.0],
  'claude-haiku-5-5': [0.1, 0.5], // acima de 100 mil tokens de prompt o preço sobe; nosso prompt é bem menor
};

function custoUsd(modelo, tokensIn, tokensOut) {
  const p = PRECOS_USD_POR_MTOK[modelo];
  if (!p) return null; // modelo sem preço conhecido: não inventa
  return ((Number(tokensIn) || 0) * p[0] + (Number(tokensOut) || 0) * p[1]) / 1e6;
}

module.exports = { PRECOS_USD_POR_MTOK, custoUsd };
