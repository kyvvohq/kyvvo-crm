// Download de mídia recebida no WhatsApp (Cloud API da Meta) — dois passos:
// 1) GET /{media-id} devolve uma URL temporária (expira em minutos) +
//    metadados; 2) GET nessa URL, com o MESMO Bearer token, devolve os
//    bytes. Persistido em disco (volume do container, /app/uploads —
//    /opt/kyvvo/crm/uploads no host) — sem storage externo (S3 etc.) por
//    ora, decisão explícita do Bruno pra não abrir escopo de infra nova
//    agora (2026-09-24).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GRAPH_API_VERSION = 'v22.0';
const DIR_UPLOADS = path.join(__dirname, '..', 'uploads');

// Extensão a partir do mime_type — nomeArquivo nem sempre vem preenchido
// pela Meta (imagens tipicamente não trazem filename, só document).
const EXTENSAO_POR_MIME = {
  'model/stl': 'stl',
  'application/sla': 'stl',
  'application/vnd.ms-pki.stl': 'stl',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

function extensaoParaMime(mimeType) {
  return EXTENSAO_POR_MIME[mimeType] || (mimeType && mimeType.split('/')[1]) || 'bin';
}

// Baixa e grava em disco; devolve { caminhoArquivo, nomeArquivo, tipoMime }.
// caminhoArquivo é relativo a DIR_UPLOADS (o que fica salvo no banco), pra
// não acoplar o schema ao path absoluto do container.
async function baixarEArmazenarMidia(mediaId, { nomeArquivoSugerido } = {}) {
  const token = process.env.META_WHATSAPP_TOKEN;
  if (!token) throw new Error('META_WHATSAPP_TOKEN não configurado no servidor.');

  const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!metaRes.ok) throw new Error(`Falha ao consultar metadados da mídia ${mediaId}: Meta respondeu ${metaRes.status}`);
  const { url, mime_type: tipoMime } = await metaRes.json();
  if (!url) throw new Error(`Mídia ${mediaId} sem URL de download.`);

  const arquivoRes = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!arquivoRes.ok) throw new Error(`Falha ao baixar bytes da mídia ${mediaId}: Meta respondeu ${arquivoRes.status}`);
  const buffer = Buffer.from(await arquivoRes.arrayBuffer());

  const extensao = extensaoParaMime(tipoMime);
  const nomeArquivo = nomeArquivoSugerido || `${mediaId}.${extensao}`;
  const nomeUnico = `${Date.now()}-${crypto.randomUUID()}-${nomeArquivo}`;
  const hoje = new Date().toISOString().slice(0, 10);
  const caminhoRelativo = path.join(hoje, nomeUnico);
  const caminhoAbsoluto = path.join(DIR_UPLOADS, caminhoRelativo);

  await fs.promises.mkdir(path.dirname(caminhoAbsoluto), { recursive: true });
  await fs.promises.writeFile(caminhoAbsoluto, buffer);

  return { caminhoArquivo: caminhoRelativo, nomeArquivo, tipoMime };
}

module.exports = { baixarEArmazenarMidia, DIR_UPLOADS };
