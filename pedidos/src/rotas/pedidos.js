const express = require('express');
const { pool } = require('../db');
const { erros } = require('../erros');
const { buscarProdutos } = require('../catalogo');
const { validarCheckout, montarPedido, uuidValido, podeCancelar } = require('../regras');
const { itensDoCarrinho } = require('./carrinho');

const router = express.Router();
const rota = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Um pedido com os seus itens, numa consulta só.
const SELECT_PEDIDO = `
  SELECT p.id, p.status, p.valor_total::float AS valor_total, p.endereco_entrega,
         p.forma_pagamento, p.cartao_final, p.criado_em,
         COALESCE(
           json_agg(json_build_object(
             'produto_id', i.produto_id,
             'nome_produto', i.nome_produto,
             'preco_unitario', i.preco_unitario::float,
             'quantidade', i.quantidade
           ) ORDER BY i.nome_produto) FILTER (WHERE i.pedido_id IS NOT NULL),
           '[]'
         ) AS itens
  FROM pedidos p
  LEFT JOIN itens_pedido i ON i.pedido_id = p.id`;

async function buscarPedido(id, usuarioId) {
  const { rows } = await pool.query(
    `${SELECT_PEDIDO} WHERE p.id = $1 AND p.usuario_id = $2 GROUP BY p.id`,
    [id, usuarioId]
  );
  return rows[0];
}

// POST /pedidos -> checkout
// 202 pedido aceito · 400 carrinho vazio / dados inválidos · 409 produto indisponível · 503 catálogo fora
router.post('/', rota(async (req, res) => {
  const { erros: detalhes, valor } = validarCheckout(req.body);
  if (detalhes.length) throw erros.dadosInvalidos(detalhes);

  const carrinho = await itensDoCarrinho(req.usuario.id);
  if (!carrinho.length) throw erros.dadosInvalidos(['o carrinho está vazio']);

  // Chamada síncrona: o preço vale o do catálogo NESTE instante. Catálogo fora -> 503.
  const produtos = await buscarProdutos(carrinho.map((i) => i.produto_id), req.get('x-request-id'));
  const { itens, total, indisponiveis } = montarPedido(carrinho, produtos);
  if (indisponiveis.length) throw erros.conflito('Produto indisponível.', indisponiveis);

  const cliente = await pool.connect();
  let pedidoId;
  try {
    await cliente.query('BEGIN');
    const { rows } = await cliente.query(
      `INSERT INTO pedidos (usuario_id, cliente_email, status, valor_total, endereco_entrega, forma_pagamento, cartao_final)
       VALUES ($1, $2, 'AGUARDANDO_ESTOQUE', $3, $4, $5, $6)
       RETURNING id`,
      [req.usuario.id, req.usuario.email, total, JSON.stringify(valor.endereco), valor.formaPagamento, valor.cartaoFinal]
    );
    pedidoId = rows[0].id;

    for (const item of itens) {
      await cliente.query(
        `INSERT INTO itens_pedido (pedido_id, produto_id, nome_produto, preco_unitario, quantidade)
         VALUES ($1, $2, $3, $4, $5)`,
        [pedidoId, item.produto_id, item.nome_produto, item.preco_unitario, item.quantidade]
      );
    }

    // Esvazia só o que entrou no pedido.
    await cliente.query(
      'DELETE FROM carrinho_itens WHERE usuario_id = $1 AND produto_id = ANY($2::text[])',
      [req.usuario.id, itens.map((i) => i.produto_id)]
    );
    await cliente.query('COMMIT');
  } catch (erro) {
    await cliente.query('ROLLBACK');
    throw erro;
  } finally {
    cliente.release();
  }

  // 202 e não 201: o pedido foi aceito, mas ainda não terminou (falta reservar o estoque
  // e cobrar). Ele fica em AGUARDANDO_ESTOQUE até o Kafka fazê-lo andar, na próxima aula.
  const pedido = await buscarPedido(pedidoId, req.usuario.id);
  res.status(202).location(`/pedidos/${pedidoId}`).json(pedido);
}));

// GET /pedidos -> 200 meus pedidos (mais novos primeiro)
router.get('/', rota(async (req, res) => {
  const { rows } = await pool.query(
    `${SELECT_PEDIDO} WHERE p.usuario_id = $1 GROUP BY p.id ORDER BY p.criado_em DESC`,
    [req.usuario.id]
  );
  res.status(200).json(rows);
}));

// GET /pedidos/:id -> 200 pedido com itens · 404 não existe ou não é meu
// 404 e não 403 no pedido de outra pessoa: um 403 confirmaria que o pedido existe.
router.get('/:id', rota(async (req, res) => {
  if (!uuidValido(req.params.id)) throw erros.naoEncontrado('Pedido não encontrado.');
  const pedido = await buscarPedido(req.params.id, req.usuario.id);
  if (!pedido) throw erros.naoEncontrado('Pedido não encontrado.');
  res.status(200).json(pedido);
}));

// POST /pedidos/:id/cancelar -> 200 cancelado · 404 não existe ou não é meu · 409 status não permite
router.post('/:id/cancelar', rota(async (req, res) => {
  if (!uuidValido(req.params.id)) throw erros.naoEncontrado('Pedido não encontrado.');

  const { rows } = await pool.query(
    `UPDATE pedidos SET status = 'CANCELADO'
     WHERE id = $1 AND usuario_id = $2 AND status = ANY($3::text[])
     RETURNING id`,
    [req.params.id, req.usuario.id, ['AGUARDANDO_ESTOQUE', 'AGUARDANDO_PAGAMENTO']]
  );

  if (!rows.length) {
    const atual = await buscarPedido(req.params.id, req.usuario.id);
    if (!atual) throw erros.naoEncontrado('Pedido não encontrado.');
    if (!podeCancelar(atual.status)) {
      throw erros.conflito(`Este pedido não pode mais ser cancelado (status: ${atual.status}).`);
    }
  }

  res.status(200).json(await buscarPedido(req.params.id, req.usuario.id));
}));

module.exports = { router };
