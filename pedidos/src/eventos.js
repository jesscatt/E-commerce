const { pool } = require('./db');
const { criarEvento, criarKafka } = require('./kafka');
const kafka = criarKafka('pedidos');

async function mudarStatus(evento, status) {
  await pool.query(
    `UPDATE pedidos SET status = $2, motivo_cancelamento = $3
     WHERE id = $1 AND status = 'AGUARDANDO_ESTOQUE'`,
    [evento.pedidoId, status, evento.dados.motivo || null]
  );
}
async function iniciar() {
  await kafka.iniciar(['estoque'], {
    'estoque.reservado': (e) => mudarStatus(e, 'AGUARDANDO_PAGAMENTO'),
    'estoque.insuficiente': (e) => mudarStatus(e, 'CANCELADO'),
  });
}
async function publicarPedido(pedido, usuario, correlationId) {
  const evento = criarEvento('pedido.criado', pedido.id, {
    usuarioId: usuario.id, clienteEmail: usuario.email, valorTotal: pedido.valor_total,
    formaPagamento: pedido.forma_pagamento, cartaoFinal: pedido.cartao_final,
    itens: pedido.itens.map((i) => ({ produtoId: i.produto_id, quantidade: i.quantidade, nome: i.nome_produto, precoUnitario: i.preco_unitario })),
  }, correlationId);
  await kafka.publicar(evento, 'pedidos');
}
module.exports = { iniciar, fechar: kafka.fechar, publicarPedido };
