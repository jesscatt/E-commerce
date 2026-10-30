const { ObjectId } = require('mongodb');
const { getDb } = require('./db');
const { criarEvento, criarKafka } = require('./kafka');
const kafka = criarKafka('catalogo');

async function reservar(evento) {
  const db = getDb();
  const reservas = db.collection('reservas');
  const produtos = db.collection('produtos');
  const { pedidoId, dados, correlationId } = evento;
  const itens = dados.itens;
  if (!Array.isArray(itens) || !itens.length || itens.some((i) =>
    !ObjectId.isValid(i.produtoId) || !Number.isInteger(i.quantidade) || i.quantidade < 1
  ) || new Set(itens.map((i) => i.produtoId)).size !== itens.length) throw new Error('Itens de reserva inválidos');

  try {
    await reservas.insertOne({ pedidoId, itens, status: 'processando', criadoEm: new Date() });
  } catch (erro) { if (erro.code !== 11000) throw erro; }
  let reserva = await reservas.findOne({ pedidoId });
  if (reserva.evento) return kafka.publicar(reserva.evento, 'estoque');

  if (reserva.status === 'processando') {
    for (const item of reserva.itens) {
      const r = await produtos.updateOne({
        _id: new ObjectId(item.produtoId), ativo: true,
        'estoque.disponivel': { $gte: item.quantidade }, reservasAplicadas: { $ne: pedidoId },
      }, {
        $inc: { 'estoque.disponivel': -item.quantidade, 'estoque.reservado': item.quantidade },
        $addToSet: { reservasAplicadas: pedidoId },
      });
      // O marcador e a alteração de estoque são atômicos no mesmo documento.
      // Se cair após o update, o replay não desconta a quantidade novamente.
      if (!r.modifiedCount && !await produtos.findOne({ _id: new ObjectId(item.produtoId), reservasAplicadas: pedidoId })) {
        await reservas.updateOne({ pedidoId }, { $set: { status: 'compensando', motivo: `Estoque insuficiente ou produto indisponível: ${item.produtoId}` } });
        break;
      }
    }
    reserva = await reservas.findOne({ pedidoId });
  }
  if (reserva.status === 'compensando') {
    for (const item of reserva.itens) {
      await produtos.updateOne({ _id: new ObjectId(item.produtoId), reservasAplicadas: pedidoId }, {
        $inc: { 'estoque.disponivel': item.quantidade, 'estoque.reservado': -item.quantidade },
        $pull: { reservasAplicadas: pedidoId },
      });
    }
  }
  const insuficiente = reserva.status === 'compensando';
  const resultado = criarEvento(insuficiente ? 'estoque.insuficiente' : 'estoque.reservado', pedidoId, {
    usuarioId: dados.usuarioId, clienteEmail: dados.clienteEmail,
    ...(insuficiente ? { motivo: reserva.motivo } : { valorTotal: dados.valorTotal, formaPagamento: dados.formaPagamento, cartaoFinal: dados.cartaoFinal }),
  }, correlationId);
  // Guarda o resultado antes de publicar: se o envio falhar, o replay republica
  // o mesmo evento sem executar a reserva/compensação outra vez.
  await reservas.updateOne({ pedidoId }, { $set: { status: insuficiente ? 'insuficiente' : 'reservado', evento: resultado } });
  await kafka.publicar(resultado, 'estoque');
}

async function iniciar() {
  await getDb().collection('reservas').createIndex({ pedidoId: 1 }, { unique: true });
  await kafka.iniciar(['pedidos'], { 'pedido.criado': reservar });
}
module.exports = { iniciar, fechar: kafka.fechar, reservar };
