// Resolve os claims de sessão de uma request. Depois deste corte o
// kyvvo-platform é a única autoridade de auth: o token é sempre RS256,
// verificado local via @kyvvohq/platform-client (JWKS, sem round-trip).
//
// Puro/injetável pra teste: recebe o header e a função de verificação RS256,
// devolve os claims normalizados ({ userId, tenantId, email, tokenVersion,
// alg }) ou null.

async function resolverClaims({ authorizationHeader, verificarRs256 }) {
  const token = String(authorizationHeader || '').replace(/^Bearer /i, '').trim();
  if (!token) return null;

  try {
    return normalizar(await verificarRs256(token));
  } catch {
    return null;
  }
}

function normalizar(c) {
  return {
    userId: c.userId,
    tenantId: c.tenantId,
    email: c.email,
    tokenVersion: c.tokenVersion,
    alg: 'RS256',
  };
}

module.exports = { resolverClaims };
