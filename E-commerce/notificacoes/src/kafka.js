const { Kafka, Partitioners, logLevel } = require('kafkajs');
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
      const novos = ['pedidos', 'estoque', 'pagamentos'].filter((topic) => !existentes.includes(topic));
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
  // Para o /health: uma pergunta de verdade ao Kafka (describeCluster), com cliente próprio,
  // sem retry e com limite de tempo. O health é chamado a cada 10 s e não pode travar.
  const kafkaSaude = new Kafka({
    clientId: `${nome}-health`, brokers: (process.env.KAFKA_BROKERS || 'kafka:9092').split(','),
    retry: { retries: 0 }, connectionTimeout: 1500, requestTimeout: 2000, logLevel: logLevel.NOTHING,
  });
  let adminSaude = null;
  async function verificar() {
    try {
      if (!adminSaude) { adminSaude = kafkaSaude.admin(); await adminSaude.connect(); }
      await Promise.race([
        adminSaude.describeCluster(),
        new Promise((_, rejeitar) => setTimeout(() => rejeitar(new Error('timeout')), 2500)),
      ]);
      return 'ok';
    } catch {
      const antigo = adminSaude; adminSaude = null;
      if (antigo) antigo.disconnect().catch(() => {});
      return 'fora do ar';
    }
  }
  async function fechar() {
    if (adminSaude) await adminSaude.disconnect().catch(() => {});
    await consumer.disconnect(); await producer.disconnect(); iniciado = false;
  }
  return { iniciar, publicar, fechar, verificar };
}
module.exports = { criarEvento, criarKafka };
