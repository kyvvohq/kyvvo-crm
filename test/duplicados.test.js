const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizarTexto, buscarSugestoesDuplicados } = require('../lib/duplicados');

test('normalizarTexto: remove acento, caixa e espaços extras', () => {
  assert.equal(normalizarTexto('José  DA Silva'), 'jose da silva');
  assert.equal(normalizarTexto(null), '');
});

test('buscarSugestoesDuplicados: agrupa por CPF igual', async () => {
  const pool = {
    query: async () => ({
      rows: [
        { id: 'a', nome: 'Ana', cpf: '11111111111', cidade: null, quantidade_pedidos: 2, criado_em: '2026-01-01' },
        { id: 'b', nome: 'Ana R', cpf: '11111111111', cidade: null, quantidade_pedidos: 0, criado_em: '2026-02-01' },
        { id: 'c', nome: 'Outra Pessoa', cpf: '22222222222', cidade: null, quantidade_pedidos: 1, criado_em: '2026-01-01' },
      ],
    }),
  };
  const grupos = await buscarSugestoesDuplicados(pool, 'tenant-1');
  assert.equal(grupos.length, 1);
  assert.equal(grupos[0].motivo, 'cpf');
  assert.deepEqual(grupos[0].clientes.map((c) => c.id).sort(), ['a', 'b']);
});

test('buscarSugestoesDuplicados: agrupa por nome parecido + mesma cidade', async () => {
  const pool = {
    query: async () => ({
      rows: [
        { id: 'a', nome: 'Maria Confeitaria', cpf: null, cidade: 'Uberlândia', quantidade_pedidos: 3, criado_em: '2026-01-01' },
        { id: 'b', nome: 'Maria Confeitaria ', cpf: null, cidade: 'uberlandia', quantidade_pedidos: 0, criado_em: '2026-02-01' },
        { id: 'c', nome: 'João Silva', cpf: null, cidade: 'Uberlândia', quantidade_pedidos: 1, criado_em: '2026-01-01' },
        { id: 'd', nome: 'Maria Confeitaria', cpf: null, cidade: 'Belo Horizonte', quantidade_pedidos: 0, criado_em: '2026-01-01' },
      ],
    }),
  };
  const grupos = await buscarSugestoesDuplicados(pool, 'tenant-1');
  assert.equal(grupos.length, 1);
  assert.equal(grupos[0].motivo, 'nome_cidade');
  assert.deepEqual(grupos[0].clientes.map((c) => c.id).sort(), ['a', 'b']);
});

test('buscarSugestoesDuplicados: sem duplicatas retorna lista vazia', async () => {
  const pool = {
    query: async () => ({
      rows: [
        { id: 'a', nome: 'Ana', cpf: '111', cidade: 'X', quantidade_pedidos: 1, criado_em: '2026-01-01' },
        { id: 'b', nome: 'Beatriz', cpf: '222', cidade: 'Y', quantidade_pedidos: 1, criado_em: '2026-01-01' },
      ],
    }),
  };
  const grupos = await buscarSugestoesDuplicados(pool, 'tenant-1');
  assert.equal(grupos.length, 0);
});
