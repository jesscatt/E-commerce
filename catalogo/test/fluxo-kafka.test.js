const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

test('fluxo completo pelo Kong, Kafka, MongoDB e Mailpit', { skip: process.env.TEST_KAFKA !== '1', timeout: 120000 }, async (t) => {
  const { Kafka, Partitioners } = require('kafkajs');
  const base = process.env.TEST_BASE_URL || 'http://gateway:8000';
  const mailpit = process.env.TEST_MAILPIT_URL || 'http://mailpit:8025';
  const nome = `teste-${randomUUID()}`;
  const kafka = new Kafka({ clientId: nome, brokers: (process.env.KAFKA_BROKERS || 'kafka:9092').split(',') });
  const consumer = kafka.consumer({ groupId: nome });
  const producer = kafka.producer({ createPartitioner: Partitioners.DefaultPartitioner });
  const admin = kafka.admin();
  const recebidos = [];
  const produtos = [], pedidos = [];
  let cliente, administrador;
  async function req(path, status, method = 'GET', body, token = cliente?.token) {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-request-id': nome }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
    assert.equal(r.status, status, `${method} ${path}`);
    return r.status === 204 ? null : r.json();
  }
  async function esperar(fn) {
    for (let i = 0; i < 120; i += 1) {
      const resultado = await fn(); if (resultado) return resultado;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('Tempo limite aguardando processamento assíncrono');
  }
  async function sincronizar(grupo) {
    const topicos = grupo === 'pedidos' ? ['estoque'] : ['pedidos', 'estoque'];
    const offsets = await admin.fetchOffsets({ groupId: grupo, topics: topicos });
    for (const topic of topicos) {
      const finais = await admin.fetchTopicOffsets(topic);
      if (finais.some((p) => p.offset !== '0' && BigInt(offsets.find((o) => o.topic === topic).partitions.find((x) => x.partition === p.partition).offset) < BigInt(p.offset))) return false;
    }
    return true;
  }
  t.after(async () => {
    // O cancelamento ainda não devolve estoque nesta aula; usa produtos exclusivos.
    for (const id of pedidos) {
      const pedido = await req(`/pedidos/${id}`, 200);
      if (pedido.status !== 'CANCELADO') await req(`/pedidos/${id}/cancelar`, 200, 'POST', {});
    }
    for (const id of produtos) await req(`/produtos/${id}`, 204, 'DELETE', null, administrador.token);
    await consumer.disconnect(); await producer.disconnect();
    await admin.deleteGroups([nome]); await admin.disconnect();
  });
  await producer.connect(); await admin.connect(); await consumer.connect();
  await consumer.subscribe({ topics: ['pedidos', 'estoque'], fromBeginning: true });
  await consumer.run({ eachMessage: async ({ topic, message }) => recebidos.push({ topic, evento: JSON.parse(message.value.toString()) }) });

  const email = `${nome}@example.com`, senha = randomUUID();
  await req('/usuarios', 201, 'POST', { nome: 'Teste Kafka', email, senha });
  cliente = await req('/auth/login', 200, 'POST', { email, senha });
  administrador = await req('/auth/login', 200, 'POST', { email: 'admin@loja.com', senha: 'admin123' });
  const categorias = await req('/categorias', 200);
  for (const estoque of [5, 0]) {
    const p = await req('/produtos', 201, 'POST', { sku: `${nome}-${estoque}`, nome: 'Produto de teste Kafka', categoria: categorias[0].slug, preco: 10, estoque: { disponivel: estoque } }, administrador.token);
    produtos.push(p.id);
  }
  const corpo = { endereco_entrega: { cep: '97000000', logradouro: 'Rua Teste', cidade: 'Santa Maria', uf: 'RS' }, forma_pagamento: 'pix' };
  const eventos = (id, tipo) => recebidos.filter((r) => r.evento.pedidoId === id && r.evento.tipo === tipo);

  await t.test('reserva estoque, muda status e preserva envelope/correlationId', async () => {
    await req('/carrinho/itens', 201, 'POST', { produto_id: produtos[0], quantidade: 2 });
    const p = await req('/pedidos', 202, 'POST', corpo); pedidos.push(p.id);
    assert.equal(p.status, 'AGUARDANDO_ESTOQUE');
    await esperar(async () => (await req(`/pedidos/${p.id}`, 200)).status === 'AGUARDANDO_PAGAMENTO');
    assert.deepEqual((await req(`/produtos/${produtos[0]}`, 200)).estoque, { disponivel: 3, reservado: 2 });
    await esperar(() => eventos(p.id, 'pedido.criado').length && eventos(p.id, 'estoque.reservado').length);
    for (const { evento } of recebidos.filter((r) => r.evento.pedidoId === p.id)) {
      assert.equal(evento.correlationId, nome); assert.ok(evento.id); assert.ok(evento.ocorridoEm);
      assert.equal(evento.dados.clienteEmail, email);
      assert.equal(evento.dados.formaPagamento, 'pix');
      assert.equal(evento.dados.numero_cartao, undefined);
    }
  });
  await t.test('falta de um item cancela com motivo e devolve os outros itens', async () => {
    for (const id of produtos) await req('/carrinho/itens', 201, 'POST', { produto_id: id, quantidade: 1 });
    const p = await req('/pedidos', 202, 'POST', corpo); pedidos.push(p.id);
    const cancelado = await esperar(async () => {
      const atual = await req(`/pedidos/${p.id}`, 200); return atual.status === 'CANCELADO' && atual;
    });
    assert.ok(cancelado.motivo_cancelamento);
    assert.deepEqual((await req(`/produtos/${produtos[0]}`, 200)).estoque, { disponivel: 3, reservado: 2 });
    assert.deepEqual((await req(`/produtos/${produtos[1]}`, 200)).estoque, { disponivel: 0, reservado: 0 });
  });
  await t.test('republicação não repete reserva nem e-mails; evento atrasado não reabre cancelado', async () => {
    const original = eventos(pedidos[0], 'pedido.criado')[0].evento;
    await producer.send({ topic: 'pedidos', messages: [{ key: original.pedidoId, value: JSON.stringify(original) }] });
    await esperar(() => eventos(original.pedidoId, 'estoque.reservado').length >= 2);
    assert.deepEqual((await req(`/produtos/${produtos[0]}`, 200)).estoque, { disponivel: 3, reservado: 2 });
    await req(`/pedidos/${original.pedidoId}/cancelar`, 200, 'POST', {});
    const reservado = eventos(original.pedidoId, 'estoque.reservado')[0].evento;
    await producer.send({ topic: 'estoque', messages: [{ key: reservado.pedidoId, value: JSON.stringify(reservado) }] });
    await esperar(() => sincronizar('pedidos'));
    assert.equal((await req(`/pedidos/${original.pedidoId}`, 200)).status, 'CANCELADO');
    await esperar(() => sincronizar('notificacoes'));
    const r = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent('to:' + email)}`);
    assert.equal(r.status, 200);
    const mensagens = (await r.json()).messages;
    assert.equal(mensagens.length, 3, 'um recebido por pedido e um cancelamento por falta de estoque');
    assert.equal(mensagens.filter((m) => m.Subject === 'Recebemos o seu pedido').length, 2);
    assert.equal(mensagens.filter((m) => m.Subject.includes('estoque insuficiente')).length, 1);
  });
});
