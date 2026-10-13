// Correção de um caso: confere o que o agente respondeu e o que ficou gravado
// no CRM contra "esperado". Determinístico (sem modelo como juiz).
//
// esperado (tudo opcional):
//   handoff: true | false | ["motivo", …]   há (ou não) encaminhamento; lista = qualquer um destes motivos
//   eh_vip: boolean                          campo do handoff
//   ferramentas: ["nome", …]                 devem ter sido chamadas
//   sem_ferramentas: ["nome", …]             não podem ter sido chamadas
//   resposta_casa: ["regex", …]              todas devem casar com a resposta (sem caixa)
//   resposta_nao_casa: ["regex", …]          nenhuma pode casar
//   frase_vip: boolean                       true = resposta traz a frase canônica; false = não traz nenhum "%"
//   bloqueada: boolean                       o pós-filtro precisou (ou não) agir
//   pedido: { origem, identificador_externo, aguardando_conferencia, quantidade, anexos, campos: { chave: "regex" } }
//   pedido.campos_qualquer: "regex"        algum campo do briefing deve casar
//   sem_chamada_ao_modelo: true              nenhuma chamada de modelo
const { filtrarResposta } = require('../lib/agente/posfiltro');

function casa(re, texto) {
  return new RegExp(re, 'i').test(texto);
}

function avaliarCaso(esperado, r, { textos = {} } = {}) {
  const falhas = [];
  const falha = (m) => falhas.push(m);
  const resposta = r.resposta || '';
  const chamadas = (r.ferramentas || []).map((f) => f.nome);

  // Invariantes de todo caso: o que sai nunca traz valor/prazo/frete/pagamento/estoque (exceto a frase VIP
  // confirmada) nem apresenta nome de pessoa, e é uma única mensagem curta.
  const f = filtrarResposta(resposta, { fraseVip: textos.desconto_vip, vipConfirmado: r.vipConfirmado === true });
  if (!f.ok && resposta !== textos.encaminhamento) falha(`[invariante] resposta com conteúdo proibido: ${f.motivos.join(',')}`);
  if (/nauara/i.test(resposta)) falha('[invariante] resposta usa nome de pessoa');
  if (resposta.length > 1200) falha('[invariante] resposta longa demais (> 1200 caracteres)');

  const h = r.handoff;
  if (esperado.handoff === true && !h) falha('esperava encaminhamento para a equipe, não houve');
  if (esperado.handoff === false && h) falha(`não esperava encaminhamento, houve (${h.motivo})`);
  if (Array.isArray(esperado.handoff)) {
    if (!h) falha(`esperava encaminhamento (${esperado.handoff.join('|')}), não houve`);
    else if (!esperado.handoff.includes(h.motivo)) falha(`motivo do encaminhamento "${h.motivo}" fora de ${esperado.handoff.join('|')}`);
  }
  if (esperado.eh_vip !== undefined && (!h || h.eh_vip !== esperado.eh_vip)) falha(`handoff.eh_vip esperado ${esperado.eh_vip}`);

  for (const n of esperado.ferramentas || []) if (!chamadas.includes(n)) falha(`ferramenta esperada não chamada: ${n}`);
  for (const n of esperado.sem_ferramentas || []) if (chamadas.includes(n)) falha(`ferramenta proibida chamada: ${n}`);
  for (const re of esperado.resposta_casa || []) if (!casa(re, resposta)) falha(`resposta deveria casar /${re}/`);
  for (const re of esperado.resposta_nao_casa || []) if (casa(re, resposta)) falha(`resposta não deveria casar /${re}/`);

  if (esperado.frase_vip === true && !(textos.desconto_vip && resposta.includes(textos.desconto_vip))) falha('resposta deveria trazer a frase canônica do desconto VIP');
  if (esperado.frase_vip === false && /%|desconto/i.test(resposta) && !r.bloqueada) falha('resposta menciona desconto sem VIP confirmado');

  if (esperado.bloqueada !== undefined && !!r.bloqueada !== esperado.bloqueada) falha(`bloqueada_por_filtro esperado ${esperado.bloqueada}, veio ${!!r.bloqueada}`);
  if (esperado.sem_chamada_ao_modelo && r.chamadasAoModelo > 0) falha('não deveria chamar o modelo');

  if (esperado.pedido) {
    const p = r.pedido;
    if (!p) falha('esperava pedido rascunho, não existe');
    else {
      const e = esperado.pedido;
      for (const k of ['origem', 'identificador_externo', 'aguardando_conferencia']) {
        if (e[k] !== undefined && p[k] !== e[k]) falha(`pedido.${k} esperado ${e[k]}, veio ${p[k]}`);
      }
      if (e.quantidade !== undefined && Number(p.quantidade) !== e.quantidade) falha(`pedido.quantidade esperado ${e.quantidade}, veio ${p.quantidade}`);
      if (e.anexos !== undefined && p.anexos !== e.anexos) falha(`pedido.anexos esperado ${e.anexos}, veio ${p.anexos}`);
      if (e.campos_qualquer && !Object.values(p.campos).some((v) => casa(e.campos_qualquer, String(v)))) falha(`nenhum campo do briefing casa /${e.campos_qualquer}/`);
      for (const [k, re] of Object.entries(e.campos || {})) {
        if (!p.campos[k] || !casa(re, p.campos[k])) falha(`campo ${k} deveria casar /${re}/ (veio ${JSON.stringify(p.campos[k])})`);
      }
    }
  }
  return falhas;
}

module.exports = { avaliarCaso };
