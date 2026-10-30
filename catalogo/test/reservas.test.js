const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

test('reservas com MongoDB real', { skip: process.env.TEST_MONGO !== '1' }, async (t) => {
  const { ObjectId } = require('mongodb');
  const { conectar, fechar } = require('../src/db');
  const { criarEvento } = require('../src/kafka');
  const publicados = [];
  let falharEnvio = false;
  const publicador = mock.method(require('../src/kafka'), 'criarKafka', () => ({ publicar: async (e) => {
    if (falharEnvio) { falharEnvio = false; throw new Error('Kafka indisponível no teste'); }
    publicados.push(e);
  } }));
  const { reservar } = require('../src/eventos');
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
  function evento(itens) {
    const id = randomUUID(); pedidos.push(id);
    return criarEvento('pedido.criado', id, { itens, usuarioId: randomUUID(), clienteEmail: 'test@example.com', valorTotal: 10, formaPagamento: 'pix' });
  }
  const estoque = async (id) => (await produtos.findOne({ _id: new ObjectId(id) })).estoque;

  await t.test('replay não reserva duas vezes e republica o mesmo resultado', async () => {
    const id = await produto(5), e = evento([{ produtoId: id, quantidade: 2 }]);
    await reservar(e); const resultado = publicados.at(-1);
    await reservar(e);
    assert.deepEqual(await estoque(id), { disponivel: 3, reservado: 2 });
    assert.equal(publicados.at(-1).id, resultado.id);
    assert.equal(resultado.correlationId, e.correlationId);
  });
  await t.test('falta no segundo item compensa o primeiro, inclusive no replay', async () => {
    const a = await produto(5), b = await produto(0);
    const e = evento([{ produtoId: a, quantidade: 2 }, { produtoId: b, quantidade: 1 }]);
    await reservar(e); await reservar(e);
    assert.equal(publicados.at(-1).tipo, 'estoque.insuficiente');
    assert.deepEqual(await estoque(a), { disponivel: 5, reservado: 0 });
    assert.deepEqual(await estoque(b), { disponivel: 0, reservado: 0 });
  });
  await t.test('falha ao publicar retoma o resultado salvo sem novo desconto', async () => {
    const id = await produto(5), e = evento([{ produtoId: id, quantidade: 2 }]);
    falharEnvio = true;
    await assert.rejects(reservar(e), /Kafka indisponível/);
    const salvo = await reservas.findOne({ pedidoId: e.pedidoId });
    await reservar(e);
    assert.equal(publicados.at(-1).id, salvo.evento.id);
    assert.deepEqual(await estoque(id), { disponivel: 3, reservado: 2 });
  });
  await t.test('dois pedidos disputando a última unidade nunca deixam estoque negativo', async () => {
    const id = await produto(1);
    const eventos = [evento([{ produtoId: id, quantidade: 1 }]), evento([{ produtoId: id, quantidade: 1 }])];
    await Promise.all(eventos.map(reservar));
    assert.deepEqual(await estoque(id), { disponivel: 0, reservado: 1 });
    const tipos = publicados.filter((p) => eventos.some((e) => e.pedidoId === p.pedidoId)).map((p) => p.tipo).sort();
    assert.deepEqual(tipos, ['estoque.insuficiente', 'estoque.reservado']);
  });
  await t.test('retoma reserva interrompida após atualizar o primeiro produto', async () => {
    const a = await produto(5), b = await produto(5);
    const e = evento([{ produtoId: a, quantidade: 2 }, { produtoId: b, quantidade: 1 }]);
    await reservas.insertOne({ pedidoId: e.pedidoId, itens: e.dados.itens, status: 'processando' });
    await produtos.updateOne({ _id: new ObjectId(a) }, { $inc: { 'estoque.disponivel': -2, 'estoque.reservado': 2 }, $addToSet: { reservasAplicadas: e.pedidoId } });
    await reservar(e);
    assert.deepEqual(await estoque(a), { disponivel: 3, reservado: 2 });
    assert.deepEqual(await estoque(b), { disponivel: 4, reservado: 1 });
  });
});
