const { Kafka, Partitioners } = require('kafkajs');
const { randomUUID } = require('node:crypto');

function criarEvento(tipo, pedidoId, dados, correlationId = randomUUID()) {
  return { id: randomUUID(), tipo, pedidoId, ocorridoEm: new Date().toISOString(), correlationId, dados };
}

function criarKafka(nome) {
  const kafka = new Kafka({ clientId: nome, brokers: (process.env.KAFKA_BROKERS || 'kafka:9092').split(','), retry: { retries: 8 } });
  const producer = kafka.producer({ createPartitioner: Partitioners.DefaultPartitioner });
  const consumer = kafka.consumer({ groupId: nome });
  let iniciado = false;
  async function iniciar(topicos, handlers) {
    const admin = kafka.admin();
    try {
      await admin.connect();
      const existentes = await admin.listTopics();
      const novos = ['pedidos', 'estoque'].filter((topic) => !existentes.includes(topic));
      if (novos.length) await admin.createTopics({ waitForLeaders: true, topics: novos.map((topic) => ({ topic, numPartitions: 3, replicationFactor: 1 })) });
    } finally { await admin.disconnect(); }
    await producer.connect();
    iniciado = true;
    await consumer.connect();
    await consumer.subscribe({ topics: topicos, fromBeginning: true });
    await consumer.run({ eachMessage: async ({ message }) => {
      const evento = JSON.parse(message.value.toString());
      if (!evento.id || !evento.pedidoId || !evento.tipo || !evento.correlationId || !evento.dados) throw new Error('Envelope de evento inválido');
      const handler = handlers[evento.tipo];
      if (!handler) return;
      console.log(`${nome} recebeu ${evento.tipo} pedido=${evento.pedidoId} correlationId=${evento.correlationId}`);
      await handler(evento);
    } });
    consumer.on(consumer.events.CRASH, ({ payload }) => {
      if (!payload.restart) {
        console.error(`${nome}: consumidor interrompido; reiniciando serviço`, payload.error.message);
        process.exit(1);
      }
    });
    iniciado = true;
  }
  async function publicar(evento, topico) {
    if (!iniciado) throw new Error('Kafka ainda não iniciado');
    await producer.send({ topic: topico, acks: -1, messages: [{ key: evento.pedidoId, value: JSON.stringify(evento) }] });
    console.log(`${nome} publicou ${evento.tipo} pedido=${evento.pedidoId} correlationId=${evento.correlationId}`);
  }
  async function fechar() { await consumer.disconnect(); await producer.disconnect(); iniciado = false; }
  return { iniciar, publicar, fechar };
}
module.exports = { criarEvento, criarKafka };
