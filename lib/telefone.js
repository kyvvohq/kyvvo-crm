// Normaliza telefone brasileiro pra E.164 (+55DDNNNNNNNNN) — chave de dedupe
// primária de cliente (ver seção 6 do doc de instruções do projeto).
// Best-effort: não valida DDD nem tamanho rígido, só normaliza o formato pra
// permitir comparação consistente entre "(11) 98765-4321", "11987654321" etc.
// Idêntico ao kyvvo-people/lib/telefone.js.
function paraE164(telefone) {
  if (!telefone) return null;
  let digitos = String(telefone).replace(/\D/g, '');
  if (!digitos) return null;

  if (digitos.startsWith('55') && digitos.length > 11) {
    // já tem o 55 do país
  } else if (digitos.length === 10 || digitos.length === 11) {
    digitos = `55${digitos}`;
  } else if (!digitos.startsWith('55')) {
    return `+${digitos}`;
  }
  return `+${digitos}`;
}

module.exports = { paraE164 };
