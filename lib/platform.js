// Cliente do serviço kyvvo-platform (@kyvvohq/platform-client), instância
// única pro processo. Usado por `authenticate` (verificação RS256 de
// token) — mesmo padrão já em produção no kyvvo-studio/kyvvo-people.
//
// PLATFORM_URL é a URL interna na rede do compose (http://platform:3003),
// não a pública — a verificação de token puxa o JWKS de lá.
const createClient = require('@kyvvohq/platform-client');

const PLATFORM_URL = process.env.PLATFORM_URL || 'http://platform:3003';

module.exports = createClient({ baseUrl: PLATFORM_URL });
