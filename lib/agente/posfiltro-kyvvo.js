// Reaproveita literalmente o pós-filtro da Basic3D: mesmo princípio (nunca
// improvisar valor/prazo/pagamento/desconto em texto livre) também vale pro
// bot da própria Kyvvo — preço de plano é decisão comercial, não do modelo.
// Começar estrito é o default mais seguro; se um dia a Kyvvo quiser liberar
// preços públicos de tabela, isso vira uma lista de exceção aqui, não um
// relaxamento geral do filtro.
module.exports = require('./posfiltro');
