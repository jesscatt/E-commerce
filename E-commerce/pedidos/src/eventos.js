const { pool } = require('./db');
const { criarEvento, criarKafka } = require('./kafka');
const kafka = criarKafka('pedidos');

// Mudança só a partir do estado esperado: o status funciona como cadeado.
// Ex.: PAGO só a partir de AGUARDANDO_PAGAMENTO. Um pedido CANCELADO não volta a PAGO
// porque o banco aprovou atrasado. Evento repetido: o filtro não casa e nada muda.
async function mudarStatus(evento, status, de, motivo = null) {
  const { rowCount } = await pool.query(
    `UPDATE pedidos SET status = $2, motivo_cancelamento = COALESCE($3, motivo_cancelamento)
     WHERE id = $1 AND status = ANY($4::text[])`,
    [evento.pedidoId, status, motivo, de]
  );
  const texto = rowCount ? `-> ${status}${motivo ? ` (${motivo})` : ''}` : `${evento.tipo} ignorado: pedido não está em ${de.join(' ou ')}`;
  console.log(`[pedidos] pedido=${evento.pedidoId} correlationId=${evento.correlationId} ${texto}`);
}

async function iniciar() {
  await kafka.iniciar(['estoque', 'pagamentos'], {
    'estoque.reservado': (e) => mudarStatus(e, 'AGUARDANDO_PAGAMENTO', ['AGUARDANDO_ESTOQUE']),
    'estoque.insuficiente': (e) => mudarStatus(e, 'CANCELADO', ['AGUARDANDO_ESTOQUE'], e.dados.motivo || 'estoque insuficiente'),
    // Também a partir de AGUARDANDO_ESTOQUE: "estoque" e "pagamentos" são tópicos diferentes e o Kafka não
    // garante a ordem entre eles. Se o aprovado chegar antes do reservado, o pedido não pode ficar preso
    // em AGUARDANDO_PAGAMENTO. O que importa continua valendo: CANCELADO nunca vira PAGO.
    'pagamento.aprovado': (e) => mudarStatus(e, 'PAGO', ['AGUARDANDO_ESTOQUE', 'AGUARDANDO_PAGAMENTO']),
    // COMPENSAÇÃO do pedido: recusa do banco e banco fora do ar chegam aqui, com motivos diferentes.
    'pagamento.recusado': (e) => mudarStatus(e, 'CANCELADO', ['AGUARDANDO_ESTOQUE', 'AGUARDANDO_PAGAMENTO'],
      `pagamento recusado: ${e.dados.motivo || 'sem motivo informado'}`),
  });
  intervalo = setInterval(reprocessarCancelamentos, 30000);
}

async function publicarPedido(pedido, usuario, correlationId) {
  const evento = criarEvento('pedido.criado', pedido.id, {
    usuarioId: usuario.id, clienteEmail: usuario.email, valorTotal: pedido.valor_total,
    formaPagamento: pedido.forma_pagamento, cartaoFinal: pedido.cartao_final,
    itens: pedido.itens.map((i) => ({ produtoId: i.produto_id, quantidade: i.quantidade, nome: i.nome_produto, precoUnitario: i.preco_unitario })),
  }, correlationId);
  await kafka.publicar(evento, 'pedidos');
}

// pedido.cancelado: o catálogo devolve o estoque e o pagamentos estorna (ou bloqueia a cobrança).
// Leva tudo que eles precisam: nenhum dos dois consulta o pedidos.
async function publicarCancelamento(pedido, correlationId) {
  const evento = criarEvento('pedido.cancelado', pedido.id, {
    usuarioId: pedido.usuario_id, clienteEmail: pedido.cliente_email, valorTotal: Number(pedido.valor_total),
    formaPagamento: pedido.forma_pagamento, cartaoFinal: pedido.cartao_final,
    motivo: pedido.motivo_cancelamento || 'cancelado pelo cliente',
  }, correlationId || undefined);
  await kafka.publicar(evento, 'pedidos');
  await pool.query('UPDATE pedidos SET cancelamento_pendente = false WHERE id = $1', [pedido.id]);
}

// Cancelamentos cujo evento não chegou ao Kafka: tenta de novo a cada 30 s.
let intervalo;
let reprocessando = false;
async function reprocessarCancelamentos() {
  if (reprocessando) return;
  reprocessando = true;
  try {
    const { rows } = await pool.query('SELECT * FROM pedidos WHERE cancelamento_pendente LIMIT 50');
    for (const pedido of rows) {
      console.log(`[pedidos] pedido=${pedido.id} republicando pedido.cancelado pendente`);
      await publicarCancelamento(pedido);
    }
  } catch (erro) {
    console.error('[pedidos] reprocessamento de cancelamentos falhou:', erro.message);
  } finally {
    reprocessando = false;
  }
}

async function fechar() {
  clearInterval(intervalo);
  await kafka.fechar();
}

module.exports = { iniciar, fechar, publicarPedido, publicarCancelamento, verificarKafka: kafka.verificar };
