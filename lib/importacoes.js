const { paraE164 } = require('./telefone');

// --- CSV genérico (US21) ----------------------------------------------------
// Parser RFC4180-lite: aspas, vírgula/ponto-e-vírgula (Excel BR exporta com
// ";") e quebras de linha dentro de campo entre aspas. Sem dependência nova
// só pra isso.
function detectarDelimitador(primeiraLinha) {
  const virgulas = (primeiraLinha.match(/,/g) || []).length;
  const puntoEVirgulas = (primeiraLinha.match(/;/g) || []).length;
  return puntoEVirgulas > virgulas ? ';' : ',';
}

function parseCsv(texto) {
  const s = texto.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const delimitador = detectarDelimitador(s.slice(0, s.indexOf('\n') === -1 ? s.length : s.indexOf('\n')));
  const linhas = [];
  let campo = '', linha = [], dentroAspas = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (dentroAspas) {
      if (ch === '"') {
        if (s[i + 1] === '"') { campo += '"'; i++; } else dentroAspas = false;
      } else campo += ch;
    } else if (ch === '"') {
      dentroAspas = true;
    } else if (ch === delimitador) {
      linha.push(campo); campo = '';
    } else if (ch === '\n') {
      linha.push(campo); campo = '';
      linhas.push(linha); linha = [];
    } else {
      campo += ch;
    }
  }
  if (campo !== '' || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas.filter((l) => !(l.length === 1 && l[0].trim() === ''));
}

// Cria ou atualiza (por telefone, depois por CPF) — mesma convenção de
// dedupe de lib/clientes.js. Update só preenche campos vazios (coalesce),
// nunca sobrescreve dado que a pessoa já tinha digitado no CRM.
async function importarLinhaCliente(client, tenantId, dados, origemPadrao) {
  const telefone = dados.telefone ? paraE164(dados.telefone) : null;
  const cpf = dados.cpf ? String(dados.cpf).replace(/\D/g, '') || null : null;

  let existente = null;
  if (telefone) {
    const r = await client.query('select id from crm_clientes where tenant_id = $1 and telefone = $2', [tenantId, telefone]);
    existente = r.rows[0] || null;
  }
  if (!existente && cpf) {
    const r = await client.query('select id from crm_clientes where tenant_id = $1 and cpf = $2 limit 1', [tenantId, cpf]);
    existente = r.rows[0] || null;
  }

  if (existente) {
    await client.query(
      `update crm_clientes set
         telefone = coalesce(telefone, $3), email = coalesce(email, $4), cpf = coalesce(cpf, $5),
         cidade = coalesce(cidade, $6), uf = coalesce(uf, $7), segmento = coalesce(segmento, $8),
         atualizado_em = now()
       where id = $1 and tenant_id = $2`,
      [existente.id, tenantId, telefone, dados.email || null, cpf, dados.cidade || null, dados.uf || null, dados.segmento || null]
    );
    return 'atualizado';
  }

  await client.query(
    `insert into crm_clientes (tenant_id, nome, telefone, email, cpf, cidade, uf, segmento, origem)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [tenantId, dados.nome, telefone, dados.email || null, cpf, dados.cidade || null, dados.uf || null, dados.segmento || null, dados.origem || origemPadrao]
  );
  return 'criado';
}

// Cada linha roda num SAVEPOINT: uma linha com erro (ex.: violação de
// constraint) não pode abortar a transação inteira — Postgres trava todo o
// resto da importação até um ROLLBACK se isso não for isolado.
async function importarClientesCsv(pool, tenantId, { cabecalho, linhas, mapeamento, nomeArquivo }) {
  const indice = {};
  for (const campo of Object.keys(mapeamento || {})) {
    if (!mapeamento[campo]) continue;
    const idx = cabecalho.indexOf(mapeamento[campo]);
    if (idx !== -1) indice[campo] = idx;
  }

  const client = await pool.connect();
  let criados = 0, atualizados = 0, comErro = 0;
  const erros = [];
  try {
    await client.query('BEGIN');
    for (let i = 0; i < linhas.length; i++) {
      const dados = {};
      for (const campo of Object.keys(indice)) dados[campo] = (linhas[i][indice[campo]] || '').trim();
      if (!dados.nome) { comErro++; erros.push(`Linha ${i + 2}: sem nome`); continue; }

      await client.query('SAVEPOINT linha_importacao');
      try {
        const resultado = await importarLinhaCliente(client, tenantId, dados, `importação: ${nomeArquivo}`);
        if (resultado === 'criado') criados++; else atualizados++;
        await client.query('RELEASE SAVEPOINT linha_importacao');
      } catch (erro) {
        await client.query('ROLLBACK TO SAVEPOINT linha_importacao');
        comErro++;
        erros.push(`Linha ${i + 2}: ${erro.message}`);
      }
    }
    const { rows } = await client.query(
      `insert into crm_importacoes (tenant_id, tipo, arquivo, status, criados, atualizados, com_erro, erro, concluido_em)
       values ($1, 'csv_generico', $2, 'concluido', $3, $4, $5, $6, now()) returning *`,
      [tenantId, nomeArquivo, criados, atualizados, comErro, erros.slice(0, 20).join(' | ') || null]
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (erro) {
    await client.query('ROLLBACK');
    throw erro;
  } finally {
    client.release();
  }
}

// --- NF-e XML (US21) ---------------------------------------------------------
// Extração por regex em vez de parser XML de verdade — schema da NF-e é
// padronizado pela SEFAZ (mesmas tags em qualquer emissor), então os campos
// usados aqui são estáveis; evita adicionar dependência só pra isto.
function extrairTag(regex, texto) {
  if (!texto) return null;
  const m = texto.match(regex);
  return m ? m[1].trim() : null;
}

function parseNfeXml(xml) {
  const chave = extrairTag(/Id="NFe(\d{44})"/, xml);
  if (!chave) throw new Error('Chave de acesso não encontrada — confira se o arquivo é o XML da NF-e (modelo 55)');

  const destBloco = extrairTag(/<dest>([\s\S]*?)<\/dest>/, xml) || '';
  const enderBloco = extrairTag(/<enderDest>([\s\S]*?)<\/enderDest>/, destBloco) || '';
  const totalBloco = extrairTag(/<ICMSTot>([\s\S]*?)<\/ICMSTot>/, xml) || '';
  const infCpl = extrairTag(/<infCpl>([\s\S]*?)<\/infCpl>/, xml) || '';

  const itens = [];
  const itensRegex = /<det[^>]*>([\s\S]*?)<\/det>/g;
  let m;
  while ((m = itensRegex.exec(xml))) {
    const bloco = m[1];
    itens.push({
      descricao: extrairTag(/<xProd>(.*?)<\/xProd>/, bloco) || 'Item',
      quantidade: Number(extrairTag(/<qCom>([\d.]+)<\/qCom>/, bloco) || '1'),
      valor_unitario: Number(extrairTag(/<vUnCom>([\d.]+)<\/vUnCom>/, bloco) || '0'),
    });
  }

  const vNF = extrairTag(/<vNF>([\d.]+)<\/vNF>/, totalBloco);
  const pedidoRef = extrairTag(/pedido[:\s#-]*([a-z0-9-]{3,})/i, infCpl);

  return {
    chave_nfe: chave,
    numero_nota: extrairTag(/<nNF>(\d+)<\/nNF>/, xml),
    cliente: {
      nome: extrairTag(/<xNome>(.*?)<\/xNome>/, destBloco),
      cpf: extrairTag(/<CPF>(\d+)<\/CPF>/, destBloco),
      cnpj: extrairTag(/<CNPJ>(\d+)<\/CNPJ>/, destBloco),
      telefone: extrairTag(/<fone>(\d+)<\/fone>/, enderBloco),
      cidade: extrairTag(/<xMun>(.*?)<\/xMun>/, enderBloco),
      uf: extrairTag(/<UF>(.*?)<\/UF>/, enderBloco),
    },
    valor_total: vNF ? Number(vNF) : null,
    identificador_externo_ref: pedidoRef,
    itens,
  };
}

// Concilia com pedido existente pelo número do pedido (referência que a
// própria conta costuma escrever nas "informações complementares" da nota,
// ex.: "Pedido: 12345") — só cria pedido novo se não achar correspondência.
// Reimportar a mesma chave de NF-e é idempotente (índice único do schema).
async function importarNfe(pool, tenantId, nfeData, nomeArquivo) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const jaImportada = await client.query(
      'select id from crm_pedidos where tenant_id = $1 and chave_nfe = $2',
      [tenantId, nfeData.chave_nfe]
    );
    if (jaImportada.rows[0]) {
      await client.query('ROLLBACK');
      return { status: 'ja_importado', pedido_id: jaImportada.rows[0].id };
    }

    let pedidoExistente = null;
    if (nfeData.identificador_externo_ref) {
      const r = await client.query(
        `select * from crm_pedidos where tenant_id = $1 and identificador_externo = $2 and chave_nfe is null`,
        [tenantId, nfeData.identificador_externo_ref]
      );
      pedidoExistente = r.rows[0] || null;
    }

    if (pedidoExistente) {
      await client.query('update crm_pedidos set chave_nfe = $1, atualizado_em = now() where id = $2', [nfeData.chave_nfe, pedidoExistente.id]);
      await client.query('COMMIT');
      return { status: 'conciliado', pedido_id: pedidoExistente.id };
    }

    const cpfOuCnpj = nfeData.cliente.cpf || nfeData.cliente.cnpj || null;
    const telefone = nfeData.cliente.telefone ? paraE164(nfeData.cliente.telefone) : null;
    let cliente = null;
    if (telefone) {
      const r = await client.query('select * from crm_clientes where tenant_id = $1 and telefone = $2', [tenantId, telefone]);
      cliente = r.rows[0] || null;
    }
    if (!cliente && cpfOuCnpj) {
      const r = await client.query('select * from crm_clientes where tenant_id = $1 and cpf = $2 limit 1', [tenantId, cpfOuCnpj]);
      cliente = r.rows[0] || null;
    }
    if (!cliente) {
      const r = await client.query(
        `insert into crm_clientes (tenant_id, nome, telefone, cpf, cidade, uf, origem) values ($1, $2, $3, $4, $5, $6, $7) returning *`,
        [tenantId, nfeData.cliente.nome || 'Sem nome', telefone, cpfOuCnpj, nfeData.cliente.cidade || null, nfeData.cliente.uf || null, `importação: NF-e ${nomeArquivo}`]
      );
      cliente = r.rows[0];
    }

    const { rows: etapaRows } = await client.query(
      `select id from crm_etapas where tenant_id = $1 and tipo = 'ganha' order by ordem limit 1`,
      [tenantId]
    );
    if (!etapaRows[0]) throw new Error('Nenhuma etapa do tipo "ganha" configurada pra receber o pedido importado');

    const { rows: pedidoRows } = await client.query(
      `insert into crm_pedidos (tenant_id, cliente_id, etapa_id, origem, valor_total, identificador_externo, chave_nfe)
       values ($1, $2, $3, 'nfe', $4, $5, $6) returning *`,
      [tenantId, cliente.id, etapaRows[0].id, nfeData.valor_total || 0, nfeData.identificador_externo_ref || null, nfeData.chave_nfe]
    );

    for (const item of nfeData.itens) {
      await client.query(
        `insert into crm_pedidos_itens (pedido_id, descricao, quantidade, valor_unitario) values ($1, $2, $3, $4)`,
        [pedidoRows[0].id, item.descricao, item.quantidade, item.valor_unitario]
      );
    }

    await client.query(
      `insert into crm_eventos (tenant_id, cliente_id, pedido_id, tipo, dados) values ($1, $2, $3, 'importacao', $4)`,
      [tenantId, cliente.id, pedidoRows[0].id, JSON.stringify({ origem: 'nfe', arquivo: nomeArquivo, chave_nfe: nfeData.chave_nfe, numero_nota: nfeData.numero_nota })]
    );

    await client.query('COMMIT');
    return { status: 'criado', pedido_id: pedidoRows[0].id };
  } catch (erro) {
    await client.query('ROLLBACK');
    throw erro;
  } finally {
    client.release();
  }
}

module.exports = { parseCsv, importarClientesCsv, importarLinhaCliente, parseNfeXml, importarNfe };
