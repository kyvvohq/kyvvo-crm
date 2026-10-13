// Carrega casos de avaliação do agente. Formato (JSON, um arquivo = lista de casos):
//
// {
//   "id": "pedido-preco",                  // único
//   "descricao": "…",
//   "setup": {                             // tudo opcional
//     "vip": true,                         // cliente com a TAG VIP no CRM
//     "foraHorario": true,                 // fora do horário de atendimento
//     "cliente_nome": "Maria Silva",       // cliente já cadastrada
//     "historico": [{ "de": "cliente"|"agente", "texto": "…" }]
//   },
//   "mensagens": [{ "texto": "…", "tipo": "texto"|"audio"|"imagem"|"documento"|…,
//                   "anexo": { "nome": "peca.stl", "mime": "model/stl" } }],  // o turno a responder
//   "esperado": { … ver evals/avaliar.js … },
//   "mock": [ …respostas do modelo falso, só no modo mock… ],
//   "somente_mock": true,                  // pula no modo real (testa a rede de proteção em código)
//   "esperado_mock": { … sobrescreve "esperado" só no modo mock … }
// }
//
// As conversas reais anonimizadas da Basic entram em evals/basic/*.json no
// mesmo formato (basta preencher "historico", "mensagens" e "esperado"; "mock"
// é opcional — casos sem mock só rodam no modo real).
const fs = require('fs');
const path = require('path');

function validar(caso, origem) {
  const erro = (m) => { throw new Error(`${origem}: caso "${caso && caso.id}" inválido — ${m}`); };
  if (!caso || typeof caso.id !== 'string' || !caso.id) erro('falta "id"');
  if (!Array.isArray(caso.mensagens) || caso.mensagens.length === 0) erro('falta "mensagens"');
  for (const m of caso.mensagens) if (typeof m.texto !== 'string') erro('mensagem sem "texto"');
  if (!caso.esperado || typeof caso.esperado !== 'object') erro('falta "esperado"');
  for (const h of (caso.setup && caso.setup.historico) || []) {
    if (!['cliente', 'agente'].includes(h.de) || typeof h.texto !== 'string') erro('histórico deve ter { de: "cliente"|"agente", texto }');
  }
  if (caso.mock !== undefined && !Array.isArray(caso.mock)) erro('"mock" deve ser lista');
  return caso;
}

function carregarCasos(...dirs) {
  const casos = [];
  const ids = new Set();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const arq of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      const origem = path.join(dir, arq);
      const lista = JSON.parse(fs.readFileSync(origem, 'utf8'));
      for (const c of Array.isArray(lista) ? lista : [lista]) {
        validar(c, origem);
        if (ids.has(c.id)) throw new Error(`${origem}: id duplicado "${c.id}"`);
        ids.add(c.id);
        casos.push(c);
      }
    }
  }
  return casos;
}

module.exports = { carregarCasos, validar };
