// Compensações da saga com MongoDB real. Rode com: TEST_MONGO=1 MONGO_URL=mongodb://localhost:27017 node --test catalogo/test
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

test('compensações com MongoDB real', { skip: process.env.TEST_MONGO !== '1' }, async (t) => {
  const { ObjectId } = require('mongodb');
  const { conectar, fechar } = require('../src/db');
  const { criarEvento } = require('../src/kafka');
  const publicador = mock.method(require('../src/kafka'), 'criarKafka', () => ({ publicar: async () => {} }));
  const { reservar, confirmar, liberar } = require('../src/eventos');
  const db = await conectar();
  const produtos = db.collection('produtos'), reservas = db.collection('reservas');
  await reservas.createIndex({ pedidoId: 1 }, { unique: true });
  const ids = [], pedidos = [];
  t.after(async () => {
    await produtos.deleteMany({ _id: { $in: ids } });
    await reservas.deleteMany({ pedidoId: { $in: pedidos } });
    await fechar(); publicador.mock.restore();
  });
  async function produto(quantidade) {
    const _id = new ObjectId(); ids.push(_id);
    await produtos.insertOne({ _id, sku: randomUUID(), ativo: true, estoque: { disponivel: quantidade, reservado: 0 } });
    return _id.toString();
  }
  async function pedidoReservado(id, quantidade) {
    const pedidoId = randomUUID(); pedidos.push(pedidoId);
    await reservar(criarEvento('pedido.criado', pedidoId, {
      itens: [{ produtoId: id, quantidade }], usuarioId: randomUUID(), clienteEmail: 't@example.com', valorTotal: 10, formaPagamento: 'pix',
    }));
    return pedidoId;
  }
  const estoque = async (id) => (await produtos.findOne({ _id: new ObjectId(id) })).estoque;
  const ev = (tipo, pedidoId, dados = {}) => criarEvento(tipo, pedidoId, dados);

  await t.test('pagamento aprovado: sai do reservado; repetido não muda nada', async () => {
    const id = await produto(5), pedidoId = await pedidoReservado(id, 2);
    await confirmar(ev('pagamento.aprovado', pedidoId));
    await confirmar(ev('pagamento.aprovado', pedidoId));
    assert.deepEqual(await estoque(id), { disponivel: 3, reservado: 0 });
  });

  await t.test('pagamento recusado: o disponível volta ao valor de antes; repetido não devolve duas vezes', async () => {
    const id = await produto(5), pedidoId = await pedidoReservado(id, 2);
    await liberar(ev('pagamento.recusado', pedidoId, { motivo: 'saldo insuficiente' }));
    await liberar(ev('pagamento.recusado', pedidoId, { motivo: 'saldo insuficiente' }));
    assert.deepEqual(await estoque(id), { disponivel: 5, reservado: 0 });
  });

  await t.test('cancelado depois de liberado não devolve de novo', async () => {
    const id = await produto(5), pedidoId = await pedidoReservado(id, 2);
    await liberar(ev('pagamento.recusado', pedidoId));
    await liberar(ev('pedido.cancelado', pedidoId));
    assert.deepEqual(await estoque(id), { disponivel: 5, reservado: 0 });
  });

  await t.test('corrida: confirmado e depois cancelado -> o produto volta uma vez só', async () => {
    const id = await produto(5), pedidoId = await pedidoReservado(id, 2);
    await confirmar(ev('pagamento.aprovado', pedidoId));
    await liberar(ev('pedido.cancelado', pedidoId));
    await liberar(ev('pedido.cancelado', pedidoId));
    assert.deepEqual(await estoque(id), { disponivel: 5, reservado: 0 });
  });

  await t.test('aprovado depois de liberado (cancelamento chegou antes) não confirma', async () => {
    const id = await produto(5), pedidoId = await pedidoReservado(id, 2);
    await liberar(ev('pedido.cancelado', pedidoId));
    await confirmar(ev('pagamento.aprovado', pedidoId));
    assert.deepEqual(await estoque(id), { disponivel: 5, reservado: 0 });
  });
});
