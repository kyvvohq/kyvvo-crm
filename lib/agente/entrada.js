// Tradução do payload do webhook da Meta (já encaminhado pelo kyvvo-platform)
// para eventos simples. Puro: sem banco, sem rede.
//
// Campos tratados:
//  - field "messages": value.messages[] (mensagens da cliente) e value.statuses[]
//    (entrega + categoria de cobrança).
//  - field "smb_message_echoes": eco de mensagens enviadas pelo app do WhatsApp
//    Business em modo coexistência (value.message_echoes[]).
//    ATENÇÃO: nome do campo vindo da documentação de coexistência da Meta;
//    conferir contra um payload real no onboarding (docs/agente/pendencias.md).

const TIPOS = {
  text: 'texto', image: 'imagem', audio: 'audio', document: 'documento',
  video: 'video', location: 'localizacao', sticker: 'figurinha',
};

function tipoNormalizado(t) {
  return TIPOS[t] || 'outro';
}

function dataDoTimestamp(ts) {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null;
}

// Uma mensagem da Meta -> { wamid, de, tipo, conteudo, midia, enviadaEm }.
function normalizarMensagem(msg) {
  const base = { wamid: msg.id || null, de: msg.from || null, enviadaEm: dataDoTimestamp(msg.timestamp), midia: null };
  const tipo = tipoNormalizado(msg.type);

  if (msg.type === 'text') return { ...base, tipo, conteudo: (msg.text || {}).body || '' };
  if (msg.type === 'interactive' && msg.interactive) {
    const r = msg.interactive.button_reply || msg.interactive.list_reply || {};
    return { ...base, tipo: 'texto', conteudo: r.title || r.id || '' };
  }
  if (msg.type === 'button' && msg.button) return { ...base, tipo: 'texto', conteudo: msg.button.text || msg.button.payload || '' };
  if (msg.type === 'image' && msg.image) {
    return { ...base, tipo, conteudo: msg.image.caption || '[imagem]', midia: { mediaId: msg.image.id, nomeArquivo: null, mime: msg.image.mime_type || null } };
  }
  if (msg.type === 'document' && msg.document) {
    return {
      ...base, tipo,
      conteudo: msg.document.caption || `[documento: ${msg.document.filename || msg.document.id}]`,
      midia: { mediaId: msg.document.id, nomeArquivo: msg.document.filename || null, mime: msg.document.mime_type || null },
    };
  }
  if (msg.type === 'location' && msg.location) return { ...base, tipo, conteudo: '[localização]' };
  // áudio, vídeo e figurinha: só registrados, nunca baixados nem interpretados
  return { ...base, tipo, conteudo: `[${tipo}]` };
}

// Corpo inteiro -> lista de "mudanças" por phone_number_id.
function extrairMudancas(body) {
  const out = [];
  for (const entry of (body && body.entry) || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const phoneNumberId = value.metadata && value.metadata.phone_number_id;
      if (!phoneNumberId) continue;
      const nomes = {};
      for (const c of value.contacts || []) if (c.wa_id) nomes[c.wa_id] = (c.profile || {}).name || null;

      out.push({
        campo: change.field || 'messages',
        phoneNumberId,
        mensagens: (value.messages || []).map((m) => ({ ...normalizarMensagem(m), nomeWhatsapp: nomes[m.from] || null })),
        statuses: (value.statuses || []).map((s) => ({
          wamid: s.id,
          status: s.status,
          categoria: (s.pricing && s.pricing.category) || (s.conversation && s.conversation.origin && s.conversation.origin.type) || null,
        })),
        ecos: (value.message_echoes || []).map((m) => ({ ...normalizarMensagem({ ...m, from: m.to }), para: m.to })),
      });
    }
  }
  return out;
}

module.exports = { extrairMudancas, normalizarMensagem, tipoNormalizado };
