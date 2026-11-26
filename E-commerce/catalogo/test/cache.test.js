// Testa o cache-aside da vitrine (src/cache.js) com um Redis falso em memória, sem rede.
// Rode com: node --test catalogo/test/cache.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// Redis falso: GET, SET com EX, INCR, PING; "fora" simula o Redis caído.
const dados = new Map();
const falso = { fora: false };
class RedisFalso {
  on() {}
  async get(chave) { if (falso.fora) throw new Error('Redis fora'); return dados.get(chave) ?? null; }
  async set(chave, valor) { if (falso.fora) throw new Error('Redis fora'); dados.set(chave, valor); return 'OK'; }
  async incr(chave) { if (falso.fora) throw new Error('Redis fora'); const v = Number(dados.get(chave) || 0) + 1; dados.set(chave, String(v)); return v; }
  async ping() { if (falso.fora) throw new Error('Redis fora'); return 'PONG'; }
  disconnect() {}
}
const carregarOriginal = Module._load;
Module._load = function (pedido, ...resto) {
  if (pedido === 'ioredis') return RedisFalso;
  return carregarOriginal.call(this, pedido, ...resto);
};
const cache = require('../src/cache');
console.log = () => {}; console.warn = () => {};

test('primeira leitura MISS, segunda HIT (sem ir ao banco)', async () => {
  let buscas = 0;
  const buscar = async () => { buscas += 1; return [{ nome: 'Camiseta', preco: 59.9 }]; };
  assert.equal((await cache.lerOuBuscar('produtos:roupas', buscar)).cache, 'MISS');
  const segunda = await cache.lerOuBuscar('produtos:roupas', buscar);
  assert.equal(segunda.cache, 'HIT');
  assert.deepEqual(segunda.valor, [{ nome: 'Camiseta', preco: 59.9 }]);
  assert.equal(buscas, 1);
});

test('invalidar (INCR da versão): o próximo GET já mostra o preço novo', async () => {
  let preco = 59.9;
  const buscar = async () => [{ nome: 'Camiseta', preco }];
  await cache.lerOuBuscar('produtos:todos', buscar);
  assert.equal((await cache.lerOuBuscar('produtos:todos', buscar)).cache, 'HIT');
  preco = 49.9;
  await cache.invalidar('produto alterado');
  const depois = await cache.lerOuBuscar('produtos:todos', buscar);
  assert.equal(depois.cache, 'MISS');
  assert.equal(depois.valor[0].preco, 49.9);
  // as chaves velhas ficam com um nome que ninguém mais procura
  assert.ok([...dados.keys()].some((k) => k.startsWith('catalogo:v0:')));
  assert.ok([...dados.keys()].some((k) => k.startsWith('catalogo:v1:')));
});

test('avalanche: 20 leituras simultâneas num MISS fazem UMA busca', async () => {
  let buscas = 0;
  const buscar = async () => { buscas += 1; await new Promise((r) => setTimeout(r, 30)); return ['x']; };
  const respostas = await Promise.all(Array.from({ length: 20 }, () => cache.lerOuBuscar('produtos:avalanche', buscar)));
  assert.equal(buscas, 1);
  assert.ok(respostas.every((r) => r.cache === 'MISS' && r.valor[0] === 'x'));
});

test('erro na busca (ex.: 404) não vai para o cache', async () => {
  await assert.rejects(cache.lerOuBuscar('produto:nao-existe', async () => { throw new Error('404'); }));
  let buscou = false;
  await cache.lerOuBuscar('produto:nao-existe', async () => { buscou = true; return { ok: true }; });
  assert.equal(buscou, true);
});

test('Redis fora: OFF, a vitrine responde direto do banco; invalidar não quebra; health "fora do ar"', async () => {
  falso.fora = true;
  const r = await cache.lerOuBuscar('produtos:roupas', async () => ['do banco']);
  assert.deepEqual(r, { valor: ['do banco'], cache: 'OFF' });
  await cache.invalidar('produto alterado com Redis fora');
  assert.equal(await cache.status(), 'fora do ar');
  falso.fora = false;
  assert.equal(await cache.status(), 'ok');
});
