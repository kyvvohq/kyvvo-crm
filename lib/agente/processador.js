// Parte assíncrona do agente: roda depois do 200 do webhook e na varredura.
// Uma conversa por vez (advisory lock) para manter a ordem das mensagens.
// A "fila" é a própria crm_mensagens_whatsapp (processada_em nulo).
const crypto = require('crypto');
const path = require('path');

const MAX_TENTATIVAS = 3;
const MIDIA_MAX_BYTES_PADRAO = 20 * 1024 * 1024;
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

function agenteEmPausa(conversa, agora) {
  return conversa.situacao === 'humano' || (conversa.pausada_ate && new Date(conversa.pausada_ate) > agora);
}

// Baixa a mídia de uma mensagem e vira anexo. Falha de mídia nunca derruba o turno.
async function anexarMidia(pool, m, { baixarMidia, armazenamento, maxBytes, log }) {
  const info = m.midia || {};
  try {
    if (!info.mediaId) return;
    const { buffer, tipoMime } = await baixarMidia(info.mediaId, { maxBytes });
    const mime = tipoMime || info.mime;
    if (!midiaPermitida({ mime, nomeArquivo: info.nomeArquivo })) throw new Error(`tipo não permitido (${mime})`);
    if (buffer.length > maxBytes) throw new Error('acima do limite de tamanho');
    const { chave } = await armazenamento.salvar({ tenantId: m.tenant_id, nomeArquivo: info.nomeArquivo || `${info.mediaId}`, buffer });
    const { rows } = await pool.query(
      `insert into crm_anexos (tenant_id, mensagem_id, chave_armazenamento, nome_arquivo, mime, tamanho, sha256)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [m.tenant_id, m.id, chave, info.nomeArquivo, mime, buffer.length, crypto.createHash('sha256').update(buffer).digest('hex')],
    );
    await pool.query('update crm_mensagens_whatsapp set anexo_id = $2 where tenant_id = $1 and id = $3', [m.tenant_id, rows[0].id, m.id]);
  } catch (err) {
    log(`[agente] mídia da mensagem ${m.id} não anexada: ${err.message}`);
    await pool.query(
      `update crm_mensagens_whatsapp set midia = coalesce(midia, '{}'::jsonb) || jsonb_build_object('erro', $3::text) where tenant_id = $1 and id = $2`,
      [m.tenant_id, m.id, err.message],
    );
  }
}

// deps.executarAgente({ pool, tenantId, conversa, mensagens }) é o ponto de
// entrada do agente (marco 3). Sem ele, o turno só registra e marca como visto.
async function processarConversa(pool, tenantId, conversaId, deps = {}) {
  const {
    executarAgente = async () => {}, baixarMidia, armazenamento,
    agora = () => new Date(), log = console.error,
    maxBytes = Number(process.env.AGENTE_MIDIA_MAX_BYTES) || MIDIA_MAX_BYTES_PADRAO,
  } = deps;

  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock(hashtextextended($1, 0))', [conversaId]);

    const { rows: [conversa] } = await pool.query(
      'select * from crm_conversas_whatsapp where tenant_id = $1 and id = $2', [tenantId, conversaId]);
    if (!conversa) return { processadas: 0 };

    const { rows: pendentes } = await pool.query(
      `select * from crm_mensagens_whatsapp
        where tenant_id = $1 and telefone_e164 = $2 and autor = 'cliente'
          and processada_em is null and tentativas < $3
        order by criado_em, id`,
      [tenantId, conversa.telefone_e164, MAX_TENTATIVAS]);
    if (pendentes.length === 0) return { processadas: 0 };
    const ids = pendentes.map((p) => p.id);

    // Uma pessoa assumiu: o agente fica em silêncio, mas a mensagem fica registrada como vista.
    if (agenteEmPausa(conversa, agora())) {
      await pool.query('update crm_mensagens_whatsapp set processada_em = now() where tenant_id = $1 and id = any($2)', [tenantId, ids]);
      return { processadas: ids.length, pausado: true };
    }

    for (const m of pendentes) {
      if (m.midia && m.midia.mediaId && (m.tipo === 'imagem' || m.tipo === 'documento') && !m.anexo_id) {
        await anexarMidia(pool, m, { baixarMidia, armazenamento, maxBytes, log });
      }
    }

    try {
      const { rows: mensagens } = await pool.query(
        'select * from crm_mensagens_whatsapp where tenant_id = $1 and id = any($2) order by criado_em, id', [tenantId, ids]);
      await executarAgente({ pool, tenantId, conversa, mensagens });
    } catch (err) {
      log(`[agente] falha no turno da conversa ${conversaId}: ${err.message}`);
      await pool.query('update crm_mensagens_whatsapp set tentativas = tentativas + 1 where tenant_id = $1 and id = any($2)', [tenantId, ids]);
      return { processadas: 0, erro: err.message };
    }
    await pool.query('update crm_mensagens_whatsapp set processada_em = now() where tenant_id = $1 and id = any($2)', [tenantId, ids]);
    return { processadas: ids.length };
  } finally {
    await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [conversaId]).catch(() => {});
    client.release();
  }
}

// Reprocessa o que ficou para trás (queda entre o 200 e o agente). Só olha
// mensagens com mais de `esperaSegundos` para não competir com o fluxo normal.
async function varrerPendentes(pool, deps = {}, { esperaSegundos = 30 } = {}) {
  const { rows } = await pool.query(
    `select distinct c.tenant_id, c.id as conversa_id
       from crm_mensagens_whatsapp m
       join crm_conversas_whatsapp c on c.tenant_id = m.tenant_id and c.telefone_e164 = m.telefone_e164
      where m.autor = 'cliente' and m.processada_em is null and m.tentativas < $1
        and m.criado_em < now() - make_interval(secs => $2)
        and m.criado_em > now() - interval '24 hours'`,
    [MAX_TENTATIVAS, esperaSegundos]);
  for (const r of rows) await processarConversa(pool, r.tenant_id, r.conversa_id, deps);
  return rows.length;
}

module.exports = { processarConversa, varrerPendentes, midiaPermitida, agenteEmPausa, MAX_TENTATIVAS };
