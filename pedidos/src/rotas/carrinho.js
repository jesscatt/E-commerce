const express = require('express');
const { pool } = require('../db');
const { erros, CatalogoIndisponivel } = require('../erros');
const { buscarProdutos } = require('../catalogo');
const { validarItemCarrinho, montarCarrinho } = require('../regras');

const router = express.Router();
const rota = (fn) => (req, res, next) => fn(req, res, next).catch(next);

async function itensDoCarrinho(usuarioId) {
  const { rows } = await pool.query(
    'SELECT produto_id, quantidade FROM carrinho_itens WHERE usuario_id = $1 ORDER BY adicionado_em, produto_id',
    [usuarioId]
  );
  return rows;
}

// GET /carrinho -> 200 { itens, total } com os preços atuais do catálogo.
// Se o catálogo estiver fora, o carrinho continua funcionando: mostra os itens sem preço.
router.get('/', rota(async (req, res) => {
  const carrinho = await itensDoCarrinho(req.usuario.id);
  if (!carrinho.length) return res.status(200).json({ itens: [], total: 0 });

  try {
    const produtos = await buscarProdutos(carrinho.map((i) => i.produto_id), req.get('x-request-id'));
    return res.status(200).json(montarCarrinho(carrinho, produtos));
  } catch (erro) {
    if (!(erro instanceof CatalogoIndisponivel)) throw erro;
    return res.status(200).json({
      itens: carrinho.map((i) => ({ produto_id: i.produto_id, quantidade: i.quantidade })),
      total: null,
      aviso: 'Catálogo indisponível: preços não puderam ser atualizados agora.',
    });
  }
}));

// POST /carrinho/itens { produto_id, quantidade }
// 201 item adicionado · 400 quantidade inválida · 404 produto não existe · 503 catálogo fora
// Se o produto já estiver no carrinho, soma a quantidade.
router.post('/itens', rota(async (req, res) => {
  const { erros: detalhes, valor } = validarItemCarrinho(req.body);
  if (detalhes.length) throw erros.dadosInvalidos(detalhes);

  // Sem FK para o catálogo: quem garante que o produto existe é a pergunta ao serviço dono.
  const produtos = await buscarProdutos([valor.produtoId], req.get('x-request-id'));
  const produto = produtos.get(valor.produtoId);
  if (!produto || !produto.ativo) throw erros.naoEncontrado('Produto não encontrado.');

  const { rows } = await pool.query(
    `INSERT INTO carrinho_itens (usuario_id, produto_id, quantidade)
     VALUES ($1, $2, $3)
     ON CONFLICT (usuario_id, produto_id)
     DO UPDATE SET quantidade = LEAST(carrinho_itens.quantidade + EXCLUDED.quantidade, 99)
     RETURNING produto_id, quantidade`,
    [req.usuario.id, valor.produtoId, valor.quantidade]
  );
  res.status(201).json({
    produto_id: rows[0].produto_id,
    nome: produto.nome,
    preco_unitario: produto.preco,
    quantidade: rows[0].quantidade,
  });
}));

// DELETE /carrinho/itens/:produtoId -> 204 removido · 404 não está no carrinho
router.delete('/itens/:produtoId', rota(async (req, res) => {
  const { rowCount } = await pool.query(
    'DELETE FROM carrinho_itens WHERE usuario_id = $1 AND produto_id = $2',
    [req.usuario.id, req.params.produtoId]
  );
  if (!rowCount) throw erros.naoEncontrado('Este produto não está no seu carrinho.');
  res.status(204).end();
}));

module.exports = { router, itensDoCarrinho };
