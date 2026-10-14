// Parte assíncrona do agente: roda depois do 200 do webhook e na
// varredura. Wrapper fininho de @kyvvohq/agente-core (fase 1 de padronizar
// o Atendimento entre produtos Kyvvo, 2026-10-14) — a allowlist de mídia
// (STL/3MF/OBJ, 100% impressão 3D) é decisão do CRM e fica aqui, injetada
// no pacote via `midiaPermitida`.
const path = require('path');
const agenteCore = require('./nucleo');

const MIMES_PERMITIDOS = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'application/pdf',
  'model/stl', 'application/sla', 'application/vnd.ms-pki.stl', 'model/3mf', 'model/obj',
]);
const EXTENSOES_MODELO_3D = new Set(['.stl', '.3mf', '.obj', '.step', '.stp']);

// STL costuma chegar como application/octet-stream: só aceita com extensão de modelo 3D.
function midiaPermitida({ mime, nomeArquivo }) {
  if (MIMES_PERMITIDOS.has(mime)) return true;
  if (mime === 'application/octet-stream') return EXTENSOES_MODELO_3D.has(path.extname(nomeArquivo || '').toLowerCase());
  return false;
}

function processarConversa(pool, tenantId, conversaId, deps = {}) {
  return agenteCore.processarConversa(pool, tenantId, conversaId, { ...deps, midiaPermitida });
}

function varrerPendentes(pool, deps = {}, opts) {
  return agenteCore.varrerPendentes(pool, { ...deps, midiaPermitida }, opts);
}

module.exports = {
  processarConversa, varrerPendentes, midiaPermitida,
  agenteEmPausa: agenteCore.agenteEmPausa, MAX_TENTATIVAS: agenteCore.MAX_TENTATIVAS,
};
