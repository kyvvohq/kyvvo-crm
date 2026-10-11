// Modelos de mensagem padrão (US25) — um por situação do Painel Hoje
// (seção 7.6 do doc). Editáveis por conta depois de criados; a chave é fixa
// porque cada uma mapeia pra um ponto específico do código (não é um
// cadastro livre como tags/produtos).
const MODELOS_PADRAO = [
  { chave: 'orcamento_parado', texto: 'Oi {{nome}}! Passando pra saber se você já viu o orçamento — posso ajudar em algo?' },
  { chave: 'pagamento_pendente', texto: 'Oi {{nome}}! Seu pedido está confirmado — só falta acertar o pagamento, posso te enviar o Pix?' },
  { chave: 'pedido_pronto', texto: 'Oi {{nome}}! Seu pedido está pronto — combinamos a retirada/entrega?' },
  { chave: 'aniversario', texto: 'Parabéns, {{nome}}! Desejamos um dia incrível. 🎉' },
  // Mesma situação do 'aniversario' (WhatsApp), mas pro ícone de e-mail do
  // Painel > Aniversariantes do mês — por isso tem assunto, diferente dos
  // modelos de WhatsApp.
  { chave: 'aniversario_email', assunto: 'Feliz aniversário, {{nome}}! 🎉', texto: 'Olá {{nome}},\n\nA equipe deseja um feliz aniversário, com muita saúde e realizações!' },
];

// Chamado uma vez por tenant (idempotente), igual a inicializarEtapasPadrao.
async function inicializarModelosPadrao(pool, tenantId) {
  const { rows } = await pool.query('select 1 from crm_modelos_mensagem where tenant_id = $1 limit 1', [tenantId]);
  if (rows.length > 0) return;
  for (const modelo of MODELOS_PADRAO) {
    await pool.query(
      `insert into crm_modelos_mensagem (tenant_id, chave, texto, assunto) values ($1, $2, $3, $4) on conflict (tenant_id, chave) do nothing`,
      [tenantId, modelo.chave, modelo.texto, modelo.assunto || null]
    );
  }
}

module.exports = { MODELOS_PADRAO, inicializarModelosPadrao };
