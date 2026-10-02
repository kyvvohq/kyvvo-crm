const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { enviarEmail } = require('../lib/email');

function fetchFalso(status = 200) {
  const chamadas = [];
  const impl = async (url, opts) => {
    chamadas.push({ url, opts, body: JSON.parse(opts.body) });
    return { ok: status < 400, status, text: async () => 'erro' };
  };
  impl.chamadas = chamadas;
  return impl;
}

const msg = { to: 'a@b.com', subject: 'Oi', html: '<p>oi</p>', tag: 'teste' };

describe('enviarEmail', () => {
  test('com PLATFORM_EMAIL_TOKEN: chama a platform com o token interno', async () => {
    const f = fetchFalso();
    const ok = await enviarEmail(msg, { env: { PLATFORM_EMAIL_TOKEN: 'tok', PLATFORM_URL: 'http://p:1', RESEND_API_KEY: 'r' }, fetchImpl: f });
    assert.equal(ok, true);
    assert.equal(f.chamadas.length, 1);
    assert.equal(f.chamadas[0].url, 'http://p:1/internal/email/send');
    assert.equal(f.chamadas[0].opts.headers['X-Internal-Token'], 'tok');
    assert.equal(f.chamadas[0].body.tag, 'teste');
  });

  test('sem token mas com RESEND_API_KEY: usa a Resend como antes', async () => {
    const f = fetchFalso();
    const ok = await enviarEmail(msg, { env: { RESEND_API_KEY: 'r', RESEND_FROM: 'X <x@kyvvo.com.br>' }, fetchImpl: f });
    assert.equal(ok, true);
    assert.equal(f.chamadas[0].url, 'https://api.resend.com/emails');
    assert.deepEqual(f.chamadas[0].body.to, ['a@b.com']);
    assert.equal(f.chamadas[0].body.from, 'X <x@kyvvo.com.br>');
  });

  test('sem nada configurado: modo log, não chama ninguém', async () => {
    const f = fetchFalso();
    assert.equal(await enviarEmail(msg, { env: {}, fetchImpl: f }), false);
    assert.equal(f.chamadas.length, 0);
  });

  test('erro HTTP ou exceção: devolve false, nunca lança', async () => {
    assert.equal(await enviarEmail(msg, { env: { PLATFORM_EMAIL_TOKEN: 't' }, fetchImpl: fetchFalso(502) }), false);
    assert.equal(await enviarEmail(msg, { env: { PLATFORM_EMAIL_TOKEN: 't' }, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }), false);
  });
});

test('repassa modelo, variaveis e layout pra platform', async () => {
  const chamadas = [];
  const f = async (url, opts) => { chamadas.push(JSON.parse(opts.body)); return { ok: true, status: 200 }; };
  await enviarEmail({ to: 'a@b.com', subject: 'S', html: '<p>h</p>', modelo: 'm', variaveis: { a: 1 }, layout: { tipo: 'aviso', titulo: 'T' } },
    { env: { PLATFORM_EMAIL_TOKEN: 't' }, fetchImpl: f });
  assert.equal(chamadas[0].modelo, 'm');
  assert.deepEqual(chamadas[0].variaveis, { a: 1 });
  assert.equal(chamadas[0].layout.titulo, 'T');
  assert.equal(chamadas[0].html, '<p>h</p>');
});
