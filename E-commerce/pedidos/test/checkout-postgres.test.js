// Opt-in: requer o PostgreSQL de desenvolvimento e as variáveis PG* configuradas.
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');

test('atomicidade do checkout com PostgreSQL real', { skip: process.env.TEST_POSTGRES !== '1' }, async (t) => {
  const identificador = `checkout-test-${randomUUID()}`;
  process.env.PGAPPNAME = identificador;
  let responderCatalogo;
  const catalogo = http.createServer((req, res) => responderCatalogo(req, res));
  catalogo.listen(0, '127.0.0.1');
  await once(catalogo, 'listening');
  process.env.CATALOGO_URL = `http://127.0.0.1:${catalogo.address().port}`;
  process.env.CATALOGO_TIMEOUT_MS = '3000';
  // Este grupo testa a transação SQL; o fluxo Kafka real é testado pelo gateway.
  const publicacao = mock.method(require('../src/eventos'), 'publicarPedido', async () => {});
  const { app } = require('../src/app');
  const { pool } = require('../src/db');
  const api = app.listen(0, '127.0.0.1');
  await once(api, 'listening');
  t.after(async () => {
    for (const servidor of [api, catalogo]) {
      const fechado = new Promise((resolve) => servidor.close(resolve));
      servidor.closeAllConnections();
      await fechado;
    }
    await pool.end();
    publicacao.mock.restore();
  });

  async function caso(t, operacao, falharCatalogo = false) {
    const usuario = randomUUID();
    const produto = randomUUID();
    const corpo = {
      endereco_entrega: { cep: '97000000', logradouro: 'Rua Teste', cidade: 'Santa Maria', uf: 'RS' },
      forma_pagamento: 'pix',
    };
    let liberar;
    let chegou;
    const liberacao = new Promise((resolve) => { liberar = resolve; });
    const consulta = new Promise((resolve) => { chegou = resolve; });
    responderCatalogo = async (req, res) => {
      chegou();
      await liberacao;
      res.setHeader('content-type', 'application/json');
      res.statusCode = falharCatalogo ? 503 : 200;
      res.end(JSON.stringify([{ id: produto, nome: 'Produto teste', preco: 10, ativo: true, estoque: { disponivel: 10 } }]));
    };
    const pendentes = [];
    async function requisitar(caminho, metodo, dados) {
      const r = await fetch(`http://127.0.0.1:${api.address().port}${caminho}`, {
        method: metodo,
        headers: { 'content-type': 'application/json', 'x-user-id': usuario, 'x-user-email': 'teste@example.com', 'x-user-role': 'cliente' },
        body: dados ? JSON.stringify(dados) : undefined,
        signal: AbortSignal.timeout(10000),
      });
      return { status: r.status, dados: await r.json() };
    }
    await pool.query('INSERT INTO carrinho_itens(usuario_id, produto_id, quantidade) VALUES ($1, $2, 1)', [usuario, produto]);
    try {
      const primeiro = requisitar('/pedidos', 'POST', corpo);
      pendentes.push(primeiro);
      await consulta; // O checkout está consultando o catálogo e mantém o item bloqueado.
      let segundo;
      if (operacao === 'checkout') segundo = requisitar('/pedidos', 'POST', corpo);
      if (operacao === 'adicao') segundo = pool.query(
        `INSERT INTO carrinho_itens(usuario_id, produto_id, quantidade) VALUES ($1, $2, 2)
         ON CONFLICT(usuario_id, produto_id) DO UPDATE SET quantidade = carrinho_itens.quantidade + EXCLUDED.quantidade`,
        [usuario, produto]
      );
      if (segundo) {
        pendentes.push(segundo);
        let bloqueado = false;
        for (let tentativa = 0; tentativa < 50; tentativa += 1) {
          const { rowCount } = await pool.query(
            `SELECT 1 FROM pg_stat_activity WHERE application_name = $1
             AND wait_event_type = 'Lock' AND query LIKE '%carrinho_itens%'`, [identificador]
          );
          if (rowCount) { bloqueado = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.ok(bloqueado, 'operação concorrente deve aguardar o item bloqueado');
      }
      liberar();
      const resposta = await primeiro;
      assert.equal(resposta.status, falharCatalogo ? 503 : 202);
      if (segundo) {
        const outra = await segundo;
        if (operacao === 'checkout') {
          assert.equal(outra.status, 400);
          assert.deepEqual(outra.dados.detalhes, ['o carrinho está vazio']);
        }
      }
      const { rows: pedidos } = await pool.query('SELECT id FROM pedidos WHERE usuario_id = $1', [usuario]);
      assert.equal(pedidos.length, falharCatalogo ? 0 : 1);
      const { rows: itens } = await pool.query('SELECT quantidade FROM carrinho_itens WHERE usuario_id = $1', [usuario]);
      assert.deepEqual(itens, falharCatalogo ? [{ quantidade: 1 }] : operacao === 'adicao' ? [{ quantidade: 2 }] : []);
    } finally {
      liberar();
      await Promise.allSettled(pendentes);
      // Exclusão limitada aos UUIDs gerados neste teste; itens_pedido tem ON DELETE CASCADE.
      await pool.query('DELETE FROM pedidos WHERE usuario_id = $1', [usuario]);
      await pool.query('DELETE FROM carrinho_itens WHERE usuario_id = $1', [usuario]);
    }
  }

  await t.test('segundo checkout aguarda o primeiro e não duplica pedido', (t) => caso(t, 'checkout'));
  await t.test('adição concorrente ao mesmo produto permanece após checkout', (t) => caso(t, 'adicao'));
  await t.test('falha no catálogo desfaz a transação e preserva o carrinho', (t) => caso(t, null, true));
});
