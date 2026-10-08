const { paraE164 } = require('./telefone');
const { proximoNumeroPedido } = require('./pedidos');
const { dispararNotificacaoEvento } = require('./notificacoes');
const { garantirOpcaoOrigem } = require('./clientes');

// Origem única pra qualquer cliente criado/atualizado por importação (CSV ou
// NF-e) — pedido do Bruno (2026-10-02): "a origem deve ser importação caso
// seja importado", no lugar das strings verbosas antigas ("importação: NF-e
// arquivo.xml" etc.), que nunca batiam com nenhuma opção cadastrada em
// Cadastro > Origens.
const ORIGEM_IMPORTACAO = 'Importação';

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

// Planilha BR tipicamente exporta data em DD/MM/AAAA (Excel/Google Sheets) —
// aceita isso e também AAAA-MM-DD (já no formato que o Postgres entende, ex.:
// exportação de outro sistema). Nunca lança: data num formato estranho vira
// null (coalesce na linha de update preserva o que já existia), não derruba
// a linha inteira da importação.
function parseDataNascimento(valor) {
  const v = String(valor || '').trim();
  if (!v) return null;
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return null;
}

// Cria ou atualiza (por telefone, depois por CPF) — mesma convenção de
// dedupe de lib/clientes.js. Update só preenche campos vazios (coalesce),
// nunca sobrescreve dado que a pessoa já tinha digitado no CRM.
async function importarLinhaCliente(client, tenantId, dados, origemPadrao) {
  const telefone = dados.telefone ? paraE164(dados.telefone) : null;
  const cpf = dados.cpf ? String(dados.cpf).replace(/\D/g, '') || null : null;
  const dataNascimento = dados.data_nascimento ? parseDataNascimento(dados.data_nascimento) : null;

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
         data_nascimento = coalesce(data_nascimento, $9), atualizado_em = now()
       where id = $1 and tenant_id = $2`,
      [existente.id, tenantId, telefone, dados.email || null, cpf, dados.cidade || null, dados.uf || null, dados.segmento || null, dataNascimento]
    );
    return 'atualizado';
  }

  await client.query(
    `insert into crm_clientes (tenant_id, nome, telefone, email, cpf, cidade, uf, segmento, origem, data_nascimento)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [tenantId, dados.nome, telefone, dados.email || null, cpf, dados.cidade || null, dados.uf || null, dados.segmento || null, dados.origem || origemPadrao, dataNascimento]
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

  await garantirOpcaoOrigem(pool, tenantId, ORIGEM_IMPORTACAO);

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
        const resultado = await importarLinhaCliente(client, tenantId, dados, ORIGEM_IMPORTACAO);
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
    await dispararNotificacaoEvento(pool, tenantId, 'importacao_concluida', {
      titulo: comErro > 0 ? 'Importação de clientes concluída com erros' : 'Importação de clientes concluída',
      detalhe: `${criados} cliente(s) novo(s), ${atualizados} atualizado(s)${comErro ? `, ${comErro} com erro` : ''}.`,
    });
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

  const itens = [];
  const itensRegex = /<det[^>]*>([\s\S]*?)<\/det>/g;
  let m;
  let pedidoRef = null;
  while ((m = itensRegex.exec(xml))) {
    const bloco = m[1];
    if (!pedidoRef) pedidoRef = extrairTag(/<xPed>(.*?)<\/xPed>/, bloco);
    itens.push({
      descricao: extrairTag(/<xProd>(.*?)<\/xProd>/, bloco) || 'Item',
      quantidade: Number(extrairTag(/<qCom>([\d.]+)<\/qCom>/, bloco) || '1'),
      valor_unitario: Number(extrairTag(/<vUnCom>([\d.]+)<\/vUnCom>/, bloco) || '0'),
    });
  }

  const vNF = extrairTag(/<vNF>([\d.]+)<\/vNF>/, totalBloco);

  // Data de emissão da nota = data do pedido (não a data da importação).
  // <dhEmi> (NF-e 3.10/4.00) traz data, hora e fuso, ex.:
  // 2026-09-24T22:19:37-03:00; <dEmi> (layout 2.00) só a data.
  const ideBloco = extrairTag(/<ide>([\s\S]*?)<\/ide>/, xml) || xml;
  const dhEmi = extrairTag(/<dhEmi>([^<]+)<\/dhEmi>/, ideBloco);
  const dEmi = extrairTag(/<dEmi>(\d{4}-\d{2}-\d{2})<\/dEmi>/, ideBloco);
  const emissao = dhEmi ? new Date(dhEmi) : dEmi ? new Date(`${dEmi}T12:00:00-03:00`) : null;

  return {
    chave_nfe: chave,
    numero_nota: extrairTag(/<nNF>(\d+)<\/nNF>/, xml),
    data_emissao: emissao && !Number.isNaN(emissao.getTime()) ? emissao : null,
    // tpNF=0 é entrada (devolução de mercadoria) e tpNF=1 é saída (venda) —
    // campo estruturado da própria NF-e, mais confiável que casar texto de
    // natOp. Decisão do Bruno (2026-09-18): devolução não vira pedido, só é
    // ignorada na importação (ver importarNfe).
    eh_devolucao: extrairTag(/<tpNF>(\d)<\/tpNF>/, xml) === '0',
    cliente: {
      nome: extrairTag(/<xNome>(.*?)<\/xNome>/, destBloco),
      cpf: extrairTag(/<CPF>(\d+)<\/CPF>/, destBloco),
      cnpj: extrairTag(/<CNPJ>(\d+)<\/CNPJ>/, destBloco),
      telefone: extrairTag(/<fone>(\d+)<\/fone>/, enderBloco),
      cidade: extrairTag(/<xMun>(.*?)<\/xMun>/, enderBloco),
      uf: extrairTag(/<UF>(.*?)<\/UF>/, enderBloco),
    },
    valor_total: vNF ? Number(vNF) : null,
    // Número do pedido (ex.: "UP2RL6028018") vem do <xPed> de cada item, não
    // do texto livre de infCpl — confirmado com XMLs reais da Basic
    // (2026-09-18). Todos os itens de uma mesma nota compartilham o mesmo xPed.
    identificador_externo_ref: pedidoRef,
    itens,
  };
}

// Concilia com pedido existente pelo número do pedido (tag <xPed> de cada
// item) — só cria pedido novo se não achar correspondência. Reimportar a
// mesma chave de NF-e é idempotente (índice único do schema). Devolução de
// mercadoria (tpNF=0) é ignorada — decisão do Bruno, não mexe no pedido
// original nem cria um novo (2026-09-18).
async function importarNfe(pool, tenantId, nfeData, nomeArquivo) {
  if (nfeData.eh_devolucao) return { status: 'devolucao_ignorada' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const jaImportada = await client.query(
      'select id from crm_pedidos where tenant_id = $1 and chave_nfe = $2',
      [tenantId, nfeData.chave_nfe]
    );
    if (jaImportada.rows[0]) {
      // Reimportar o mesmo XML corrige a data de pedidos criados antes desta
      // correção (que ficaram com a data da importação). Só mexe em pedido
      // que nasceu da própria NF-e.
      if (nfeData.data_emissao) {
        await client.query(
          `update crm_pedidos set criado_em = $1, data_emissao_nf = ($1 at time zone 'America/Sao_Paulo')::date where id = $2 and origem = 'nfe' and criado_em is distinct from $1`,
          [nfeData.data_emissao, jaImportada.rows[0].id]
        );
      }
      await client.query('COMMIT');
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
        [tenantId, nfeData.cliente.nome || 'Sem nome', telefone, cpfOuCnpj, nfeData.cliente.cidade || null, nfeData.cliente.uf || null, ORIGEM_IMPORTACAO]
      );
      cliente = r.rows[0];
    }

    const { rows: etapaRows } = await client.query(
      `select id from crm_etapas where tenant_id = $1 and tipo = 'ganha' order by ordem limit 1`,
      [tenantId]
    );
    if (!etapaRows[0]) throw new Error('Nenhuma etapa do tipo "ganha" configurada pra receber o pedido importado');

    const numeroPedido = await proximoNumeroPedido(client, tenantId);
    // valor_recebido = valor_total e status_pagamento = 'pago' de propósito:
    // uma NF-e importada é prova de uma venda JÁ CONCLUÍDA e faturada no
    // passado — diferente de um pedido criado pelo Kanban/bot, que pode
    // ficar em etapa "ganha" sem ainda estar totalmente pago (entrega
    // fiada, por exemplo). Sem isso, "total gasto"/"ticket médio" do
    // cliente (lib/clientes.js#buscarMetricas, que soma valor_recebido) e o
    // card "Pagamentos pendentes" do Painel Hoje ficavam incorretos pra
    // todo pedido importado (bug real, 2026-10-03).
    const { rows: pedidoRows } = await client.query(
      `insert into crm_pedidos (tenant_id, cliente_id, etapa_id, origem, valor_total, valor_recebido, status_pagamento, identificador_externo, chave_nfe, numero, criado_em, entrou_na_etapa_em, data_emissao_nf)
       values ($1, $2, $3, 'nfe', $4, $4, 'pago', $5, $6, $7, coalesce($8, now()), coalesce($8, now()), (coalesce($8, now()) at time zone 'America/Sao_Paulo')::date) returning *`,
      [tenantId, cliente.id, etapaRows[0].id, nfeData.valor_total || 0, nfeData.identificador_externo_ref || null, nfeData.chave_nfe, numeroPedido, nfeData.data_emissao]
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

// Processa o lote inteiro em segundo plano — a rota HTTP já respondeu
// 202 com o registro em 'processando' antes de chamar isto (nunca espera
// terminar). Atualiza criados/atualizados/com_erro a CADA arquivo (não só no
// final) pra GET /crm/api/importacoes/:id, usado em polling pela tela,
// mostrar progresso de verdade ("7 de 14"), não só "processando" parado.
// Dispara a notificação de conclusão (sucesso/erro) só no final — é aí que
// faz sentido pra quem não ficou olhando a tela esperando.
async function processarImportacaoNfeEmSegundoPlano(pool, tenantId, importacaoId, arquivos) {
  await garantirOpcaoOrigem(pool, tenantId, ORIGEM_IMPORTACAO);
  let criados = 0, atualizados = 0, comErro = 0;
  const notas = [];
  for (const arquivo of arquivos) {
    try {
      const nfeData = parseNfeXml(arquivo.buffer.toString('utf8'));
      const resultado = await importarNfe(pool, tenantId, nfeData, arquivo.nome);
      if (resultado.status === 'criado') criados++;
      else if (resultado.status === 'conciliado') atualizados++;
      notas.push(`${arquivo.nome}: ${resultado.status}`);
    } catch (erro) {
      comErro++;
      notas.push(`${arquivo.nome}: erro — ${erro.message}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await pool.query(
      'update crm_importacoes set criados = $2, atualizados = $3, com_erro = $4 where id = $1',
      [importacaoId, criados, atualizados, comErro]
    );
  }
  await pool.query(
    `update crm_importacoes set status = 'concluido', erro = $2, concluido_em = now() where id = $1`,
    [importacaoId, notas.slice(0, 50).join(' | ') || null]
  );

  const resumo = `${criados} pedido(s) novo(s), ${atualizados} conciliado(s)${comErro ? `, ${comErro} com erro` : ''} de ${arquivos.length} arquivo(s).`;
  await dispararNotificacaoEvento(pool, tenantId, 'importacao_concluida', {
    titulo: comErro > 0 ? 'Importação de NF-e concluída com erros' : 'Importação de NF-e concluída',
    detalhe: resumo,
  });
}

module.exports = {
  parseCsv, importarClientesCsv, importarLinhaCliente, parseNfeXml, importarNfe,
  processarImportacaoNfeEmSegundoPlano,
};
