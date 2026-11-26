const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { CatalogoIndisponivel } = require('../src/erros');

let servidor;
let buscarProdutos;
let responder;
before(async () => {
  servidor = http.createServer((req, res) => responder(req, res));
  await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  process.env.CATALOGO_URL = `http://127.0.0.1:${servidor.address().port}`;
  process.env.CATALOGO_TIMEOUT_MS = '100';
  ({ buscarProdutos } = require('../src/catalogo'));
});
after(() => new Promise((resolve) => {
  servidor.close(resolve);
  servidor.closeAllConnections();
}));

test('consulta todos os produtos numa chamada e propaga X-Request-Id', async () => {
  let chamadas = 0;
  responder = (req, res) => {
    chamadas += 1;
    assert.equal(req.url, '/produtos?ids=abc,def');
    assert.equal(req.headers['x-request-id'], 'checkout-teste');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([{ id: 'abc', preco: 19.9 }, { id: 'def', preco: 10 }]));
  };
  const produtos = await buscarProdutos(['abc', 'def'], 'checkout-teste');
  assert.equal(chamadas, 1);
  assert.equal(produtos.size, 2);
  assert.equal(produtos.get('abc').preco, 19.9);
});

test('carrinho vazio não depende do catálogo', async () => {
  responder = () => assert.fail('não deve fazer chamada HTTP');
  assert.equal((await buscarProdutos([])).size, 0);
});

test('erro HTTP do catálogo vira CatalogoIndisponivel', async () => {
  responder = (req, res) => { res.writeHead(503); res.end(); };
  await assert.rejects(buscarProdutos(['abc']), CatalogoIndisponivel);
});

test('resposta inválida do catálogo vira CatalogoIndisponivel', async () => {
  responder = (req, res) => res.end('não é JSON');
  await assert.rejects(buscarProdutos(['abc']), CatalogoIndisponivel);
});

test('catálogo travado é interrompido pelo timeout', { timeout: 2000 }, async () => {
  responder = () => {}; // Mantém a conexão aberta até o cliente abortar.
  await assert.rejects(buscarProdutos(['abc']), CatalogoIndisponivel);
});
