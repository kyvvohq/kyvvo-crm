// Número sequencial do pedido por tenant (nº 1, nº 2... que o dono do
// negócio reconhece, diferente do id uuid) — ver db/010_pedido_numero_entrega.sql.
// `client` aceita tanto o pool quanto uma conexão de transação (`pool.connect()`),
// já que quem cria pedido normalmente já está dentro de uma transação.
async function proximoNumeroPedido(client, tenantId) {
  const { rows } = await client.query(
    'select coalesce(max(numero), 0) + 1 as proximo from crm_pedidos where tenant_id = $1',
    [tenantId]
  );
  return rows[0].proximo;
}

module.exports = { proximoNumeroPedido };
