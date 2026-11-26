const { ObjectId } = require('mongodb');
const { getDb } = require('./db');
const { criarEvento, criarKafka } = require('./kafka');
const kafka = criarKafka('catalogo');
const cache = require('./cache');

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
  // O estoque mudou (reservou, ou reservou e devolveu): a vitrine em cache ficou velha.
  await cache.invalidar(`reserva do pedido ${pedidoId}`);
  // Guarda o resultado antes de publicar: se o envio falhar, o replay republica
  // o mesmo evento sem executar a reserva/compensação outra vez.
  await reservas.updateOne({ pedidoId }, { $set: { status: insuficiente ? 'insuficiente' : 'reservado', evento: resultado } });
  await kafka.publicar(resultado, 'estoque');
}

// ------------------------------------------------------------------ saga: reagir ao pagamento
// Estados da reserva: reservado -> confirmando -> confirmada   (pagamento.aprovado)
//                     reservado -> liberando   -> liberada     (pagamento.recusado, pedido.cancelado)
//                     confirmada -> devolvendo -> liberada     (cancelado depois de a reserva já ter sido confirmada)
// O filtro de estado é a idempotência: evento repetido não confirma nem devolve duas vezes.
// O estado intermediário (confirmando, liberando, devolvendo) permite retomar se o serviço cair no meio:
// cada produto tem um marcador próprio, então o replay não aplica a mesma quantidade outra vez.

const log = (pedidoId, correlationId, texto) =>
  console.log(`[catalogo] pedido=${pedidoId} correlationId=${correlationId || '-'} ${texto}`);

// Passa a reserva de "de" para "intermediario"; se ela já estava no intermediário (queda no meio), retoma.
async function tomarReserva(pedidoId, de, intermediario) {
  const reservas = getDb().collection('reservas');
  return (await reservas.findOneAndUpdate(
    { pedidoId, status: de },
    { $set: { status: intermediario, atualizadoEm: new Date() } },
    { returnDocument: 'after' }
  )) || reservas.findOne({ pedidoId, status: intermediario });
}

// pagamento.aprovado: o produto sai do reservado. O disponível já tinha diminuído na reserva.
async function confirmar(evento) {
  const { pedidoId, correlationId } = evento;
  const produtos = getDb().collection('produtos');
  const reserva = await tomarReserva(pedidoId, 'reservado', 'confirmando');
  if (!reserva) return log(pedidoId, correlationId, 'confirmar: reserva não está mais reservada, nada a fazer');

  for (const item of reserva.itens) {
    await produtos.updateOne({ _id: new ObjectId(item.produtoId), reservasAplicadas: pedidoId }, {
      $inc: { 'estoque.reservado': -item.quantidade },
      $pull: { reservasAplicadas: pedidoId },
    });
  }
  await getDb().collection('reservas').updateOne({ pedidoId }, { $set: { status: 'confirmada', atualizadoEm: new Date() } });
  await cache.invalidar(`venda do pedido ${pedidoId}`);
  log(pedidoId, correlationId, 'reserva CONFIRMADA (produto vendido)');
}

// pagamento.recusado e pedido.cancelado: COMPENSAÇÃO, o estoque volta para o disponível.
// É a mesma função para recusa e cancelamento.
async function liberar(evento) {
  const { pedidoId, correlationId, tipo, dados } = evento;
  const db = getDb();
  const produtos = db.collection('produtos');
  const motivo = dados.motivo || tipo;

  let reserva = await tomarReserva(pedidoId, 'reservado', 'liberando');
  if (reserva) {
    for (const item of reserva.itens) {
      await produtos.updateOne({ _id: new ObjectId(item.produtoId), reservasAplicadas: pedidoId }, {
        $inc: { 'estoque.disponivel': item.quantidade, 'estoque.reservado': -item.quantidade },
        $pull: { reservasAplicadas: pedidoId },
      });
    }
    await db.collection('reservas').updateOne({ pedidoId }, { $set: { status: 'liberada', motivoLiberacao: motivo, atualizadoEm: new Date() } });
    await cache.invalidar(`devolução do pedido ${pedidoId}`);
    return log(pedidoId, correlationId, `COMPENSAÇÃO: estoque DEVOLVIDO (${tipo}: ${motivo})`);
  }

  // Corrida: o pagamento foi aprovado e a reserva confirmada, mas o cliente cancelou.
  // O pagamentos estorna; aqui o produto vendido volta para o disponível.
  if (tipo === 'pedido.cancelado') {
    reserva = await tomarReserva(pedidoId, 'confirmada', 'devolvendo');
    if (reserva) {
      for (const item of reserva.itens) {
        await produtos.updateOne({ _id: new ObjectId(item.produtoId), devolucoesAplicadas: { $ne: pedidoId } }, {
          $inc: { 'estoque.disponivel': item.quantidade },
          $addToSet: { devolucoesAplicadas: pedidoId },
        });
      }
      await db.collection('reservas').updateOne({ pedidoId }, { $set: { status: 'liberada', motivoLiberacao: motivo, atualizadoEm: new Date() } });
      await cache.invalidar(`devolução do pedido ${pedidoId}`);
      return log(pedidoId, correlationId, 'COMPENSAÇÃO: venda confirmada devolvida ao estoque (pedido cancelado)');
    }
  }
  log(pedidoId, correlationId, `liberar (${tipo}): reserva não está reservada, nada a devolver`);
}

async function iniciar() {
  await getDb().collection('reservas').createIndex({ pedidoId: 1 }, { unique: true });
  await kafka.iniciar(['pedidos', 'pagamentos'], {
    'pedido.criado': reservar,
    'pedido.cancelado': liberar,      // COMPENSAÇÃO
    'pagamento.aprovado': confirmar,
    'pagamento.recusado': liberar,    // COMPENSAÇÃO
  });
}
module.exports = { iniciar, fechar: kafka.fechar, reservar, confirmar, liberar, verificarKafka: kafka.verificar };
