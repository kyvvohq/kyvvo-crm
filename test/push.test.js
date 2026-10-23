const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { enviarPush } = require('../lib/push');
const { canaisAtivos } = require('../lib/notificacoes');

describe('canaisAtivos: canal push', () => {
  test('formato novo (canais.push) reflete o valor salvo', () => {
    assert.equal(canaisAtivos({ canais: { crm: true, push: true } }).push, true);
    assert.equal(canaisAtivos({ canais: { crm: true, push: false } }).push, false);
    assert.equal(canaisAtivos({ canais: { crm: true } }).push, false);
  });

  test('formato antigo ({ativo: bool}) e ausência de config: push sempre false', () => {
    assert.equal(canaisAtivos({ ativo: true }).push, false);
    assert.equal(canaisAtivos(undefined).push, false);
  });
});

// Sem VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY no ambiente (nem em dev/teste, nem
// no CI) enviarPush cai no modo log — mesmo espírito de lib/email.js sem as
// envs externas. O caminho real de envio (com webpush.sendNotification de
// verdade) só é exercitado em produção, com as chaves vindas do SSM
// (/kyvvo/crm/).
describe('enviarPush (sem VAPID configurado — modo dev/log)', () => {
  test('não consulta crm_push_subscriptions nem lança', async () => {
    const chamadas = [];
    const pool = { query: async (sql, params) => { chamadas.push({ sql, params }); return { rows: [] }; } };
    await assert.doesNotReject(enviarPush(pool, 't1', { titulo: 'Novo pedido', corpo: 'Pedido #42' }));
    assert.deepEqual(chamadas, []);
  });
});
