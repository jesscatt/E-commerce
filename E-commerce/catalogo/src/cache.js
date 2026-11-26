// Cache da vitrine no Redis, no padrão CACHE-ASIDE (slides "O PADRÃO CACHE-ASIDE" e "VERSÃO NA PRÁTICA"):
//   1. procura no Redis; achou -> HIT, devolve sem tocar no Mongo;
//   2. não achou -> MISS, busca no Mongo e guarda por 60 s (TTL);
//   3. Redis fora -> OFF, vai direto ao Mongo: o cache acelera, não sustenta.
//
// Invalidação por VERSÃO: cada filtro da vitrine é uma chave (roupas, busca=camiseta, todos...).
// Em vez de apagar uma por uma, toda escrita faz INCR em catalogo:versao. A versão faz parte do NOME
// das chaves (catalogo:v8:produtos:...): as chaves da versão velha ninguém mais procura, e vencem pelo TTL.
const Redis = require('ioredis');

const TTL_SEGUNDOS = Number(process.env.CACHE_TTL_SEGUNDOS) || 60;
const CHAVE_VERSAO = 'catalogo:versao';

const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379', {
  enableOfflineQueue: false,   // Redis fora? falha na hora, em vez de enfileirar esperando ele voltar
  maxRetriesPerRequest: 0,
  connectTimeout: 1000,
  retryStrategy: () => 2000,   // tenta reconectar a cada 2 s, em segundo plano
});
redis.on('error', () => {});   // os erros são tratados em cada chamada; não polui o log

// Avalanche (stampede): se muitas requisições pedem a mesma chave num MISS, só UMA vai ao Mongo;
// as outras esperam o mesmo resultado.
const emAndamento = new Map();

// Retorna { valor, cache: 'HIT' | 'MISS' | 'OFF' }. "nome" é a resposta: 'categorias', 'produto:<id>'...
async function lerOuBuscar(nome, buscar) {
  let chave;
  try {
    const versao = (await redis.get(CHAVE_VERSAO)) || '0';
    chave = `catalogo:v${versao}:${nome}`;
    const guardado = await redis.get(chave);
    if (guardado) return { valor: JSON.parse(guardado), cache: 'HIT' };
  } catch {
    return { valor: await buscar(), cache: 'OFF' };
  }

  if (!emAndamento.has(chave)) {
    const busca = (async () => {
      const valor = await buscar();
      // TTL com variação: chaves criadas juntas não vencem todas no mesmo segundo.
      const ttl = TTL_SEGUNDOS + Math.floor(Math.random() * 10);
      await redis.set(chave, JSON.stringify(valor), 'EX', ttl).catch(() => {});
      return valor;
    })().finally(() => emAndamento.delete(chave));
    emAndamento.set(chave, busca);
  }
  return { valor: await emAndamento.get(chave), cache: 'MISS' };
}

// Toda escrita de produto ou categoria, e toda mudança de estoque, chama isto.
// Se o Redis estiver fora, não dá para invalidar: o TTL de 60 s limita quanto tempo a vitrine fica velha.
async function invalidar(motivo) {
  try {
    const versao = await redis.incr(CHAVE_VERSAO);
    console.log(`[catalogo] cache invalidado (${motivo}): versão ${versao}`);
  } catch {
    console.warn(`[catalogo] WARN cache não invalidado (${motivo}): Redis fora; o TTL de ${TTL_SEGUNDOS} s limita`);
  }
}

async function status() {
  try {
    await Promise.race([
      redis.ping(),
      new Promise((_, rejeitar) => setTimeout(() => rejeitar(new Error('timeout')), 1000)),
    ]);
    return 'ok';
  } catch {
    return 'fora do ar';
  }
}

async function fechar() {
  redis.disconnect();
}

module.exports = { lerOuBuscar, invalidar, status, fechar };
