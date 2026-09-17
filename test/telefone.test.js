const { test } = require('node:test');
const assert = require('node:assert/strict');
const { paraE164 } = require('../lib/telefone');

test('paraE164: entradas vazias ou só pontuação retornam null', () => {
  assert.equal(paraE164(null), null);
  assert.equal(paraE164(undefined), null);
  assert.equal(paraE164(''), null);
  assert.equal(paraE164('()-'), null);
});

test('paraE164: celular (11 díg) com ou sem formatação vira +55DDNNNNNNNNN', () => {
  assert.equal(paraE164('(11) 98765-4321'), '+5511987654321');
  assert.equal(paraE164('11987654321'), '+5511987654321');
});

test('paraE164: fixo (10 díg) recebe o 55 do país', () => {
  assert.equal(paraE164('1132654321'), '+551132654321');
});

test('paraE164: já com 55 e mais de 11 dígitos não duplica o país', () => {
  assert.equal(paraE164('5511987654321'), '+5511987654321');
});
