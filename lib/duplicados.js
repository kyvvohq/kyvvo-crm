function normalizarTexto(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim().replace(/\s+/g, ' ');
}

// Distância de Levenshtein — só roda entre nomes já filtrados pela mesma
// cidade, então o volume de comparações em JS puro fica pequeno mesmo com
// muitos clientes cadastrados.
function distanciaLevenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function nomesParecidos(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) return true;
  const distancia = distanciaLevenshtein(a, b);
  return distancia <= Math.max(1, Math.floor(Math.min(a.length, b.length) * 0.2));
}

// Sugestão de mesclagem (US17, doc seção 6: mesclagem "sempre confirmada por
// um humano — nunca automática"). Dois critérios de agrupamento: CPF igual,
// ou nome+cidade parecidos — em ambos os casos só retorna a sugestão, quem
// decide mesclar (e qual ficha mantém) é sempre a pessoa.
async function buscarSugestoesDuplicados(pool, tenantId) {
  const { rows: clientes } = await pool.query(
    `select id, nome, telefone, email, cpf, cidade, uf, criado_em,
       (select count(*) from crm_pedidos where cliente_id = c.id)::int as quantidade_pedidos
     from crm_clientes c where tenant_id = $1 order by criado_em`,
    [tenantId]
  );

  const grupos = [];
  const jaAgrupado = new Set();

  const porCpf = new Map();
  for (const c of clientes) {
    if (!c.cpf) continue;
    if (!porCpf.has(c.cpf)) porCpf.set(c.cpf, []);
    porCpf.get(c.cpf).push(c);
  }
  for (const grupo of porCpf.values()) {
    if (grupo.length < 2) continue;
    grupos.push({ motivo: 'cpf', clientes: grupo });
    grupo.forEach((c) => jaAgrupado.add(c.id));
  }

  const restantes = clientes.filter((c) => !jaAgrupado.has(c.id) && c.cidade);
  const porCidade = new Map();
  for (const c of restantes) {
    const cidadeNorm = normalizarTexto(c.cidade);
    if (!porCidade.has(cidadeNorm)) porCidade.set(cidadeNorm, []);
    porCidade.get(cidadeNorm).push({ ...c, _nomeNorm: normalizarTexto(c.nome) });
  }
  for (const grupoCidade of porCidade.values()) {
    const usados = new Set();
    for (let i = 0; i < grupoCidade.length; i++) {
      if (usados.has(grupoCidade[i].id)) continue;
      const grupo = [grupoCidade[i]];
      for (let j = i + 1; j < grupoCidade.length; j++) {
        if (usados.has(grupoCidade[j].id)) continue;
        if (nomesParecidos(grupoCidade[i]._nomeNorm, grupoCidade[j]._nomeNorm)) grupo.push(grupoCidade[j]);
      }
      if (grupo.length > 1) {
        grupo.forEach((c) => usados.add(c.id));
        grupos.push({ motivo: 'nome_cidade', clientes: grupo.map(({ _nomeNorm, ...c }) => c) });
      }
    }
  }

  return grupos;
}

// Migra tudo do cliente descartado pro mantido e apaga o descartado.
// Campos vazios do mantido são preenchidos com os do descartado (coalesce);
// telefone precisa ser esvaziado do descartado antes, senão bate no índice
// único (tenant_id, telefone) ao tentar copiar o mesmo valor pro mantido.
async function mesclarClientes(pool, tenantId, manterId, descartarId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'select * from crm_clientes where tenant_id = $1 and id = any($2::uuid[]) for update',
      [tenantId, [manterId, descartarId]]
    );
    const manter = rows.find((r) => r.id === manterId);
    const descartar = rows.find((r) => r.id === descartarId);
    if (!manter || !descartar) {
      await client.query('ROLLBACK');
      return null;
    }

    await client.query('update crm_clientes set telefone = null where id = $1', [descartarId]);
    await client.query(
      `update crm_clientes set
         telefone = coalesce(telefone, $3), email = coalesce(email, $4), cpf = coalesce(cpf, $5),
         cidade = coalesce(cidade, $6), uf = coalesce(uf, $7), cep = coalesce(cep, $8),
         data_nascimento = coalesce(data_nascimento, $9), segmento = coalesce(segmento, $10),
         observacoes = case
           when observacoes is null or observacoes = '' then $11::text
           when $11::text is null or $11::text = '' then observacoes
           else observacoes || E'\n---\n' || $11::text
         end,
         atualizado_em = now()
       where id = $1 and tenant_id = $2`,
      [manterId, tenantId, descartar.telefone, descartar.email, descartar.cpf, descartar.cidade,
        descartar.uf, descartar.cep, descartar.data_nascimento, descartar.segmento, descartar.observacoes]
    );

    await client.query('update crm_pedidos set cliente_id = $1 where cliente_id = $2', [manterId, descartarId]);
    await client.query('update crm_eventos set cliente_id = $1 where cliente_id = $2', [manterId, descartarId]);
    await client.query('update crm_formularios_respostas set cliente_id = $1 where cliente_id = $2', [manterId, descartarId]);
    await client.query(
      `insert into crm_clientes_tags (cliente_id, tag_id) select $1, tag_id from crm_clientes_tags where cliente_id = $2
       on conflict do nothing`,
      [manterId, descartarId]
    );
    await client.query(
      `insert into crm_clientes_valores (cliente_id, campo_id, valor)
       select $1, campo_id, valor from crm_clientes_valores d where cliente_id = $2
       and not exists (select 1 from crm_clientes_valores k where k.cliente_id = $1 and k.campo_id = d.campo_id)`,
      [manterId, descartarId]
    );
    await client.query('delete from crm_clientes where id = $1', [descartarId]);
    await client.query(
      `insert into crm_eventos (tenant_id, cliente_id, tipo, dados) values ($1, $2, 'mesclagem', $3)`,
      [tenantId, manterId, JSON.stringify({ descartado_id: descartarId, descartado_nome: descartar.nome })]
    );

    await client.query('COMMIT');
  } catch (erro) {
    await client.query('ROLLBACK');
    throw erro;
  } finally {
    client.release();
  }
  const { rows: final } = await pool.query('select * from crm_clientes where id = $1', [manterId]);
  return final[0];
}

module.exports = { buscarSugestoesDuplicados, mesclarClientes, normalizarTexto };
