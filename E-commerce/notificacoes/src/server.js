const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const { dirname } = require('node:path');
const nodemailer = require('nodemailer');
const http = require('node:http');
const { criarKafka } = require('./kafka');

const arquivo = process.env.NOTIFICACOES_DB || '/data/notificacoes.sqlite';
mkdirSync(dirname(arquivo), { recursive: true });
const db = new DatabaseSync(arquivo);
db.exec('CREATE TABLE IF NOT EXISTS enviados (evento_id TEXT PRIMARY KEY, enviado_em TEXT NOT NULL)');
const enviado = db.prepare('SELECT 1 FROM enviados WHERE evento_id = ?');
const registrar = db.prepare('INSERT OR IGNORE INTO enviados VALUES (?, ?)');
const smtp = nodemailer.createTransport({ host: process.env.SMTP_HOST || 'mailpit', port: Number(process.env.SMTP_PORT || 1025), secure: false });
const kafka = criarKafka('notificacoes');

const reais = (valor) => `R$ ${Number(valor || 0).toFixed(2).replace('.', ',')}`;

// Um e-mail por tipo de evento. O "pedido confirmado" só sai depois do pagamento aprovado:
// antes disso, só "recebemos o seu pedido" (o irreversível vai o mais para o fim possível).
const MENSAGENS = {
  'pedido.criado': () => ({
    assunto: 'Recebemos o seu pedido',
    texto: 'Recebido! Estamos verificando o estoque e, em seguida, o pagamento.',
  }),
  'estoque.insuficiente': (e) => ({
    assunto: 'Pedido cancelado: estoque insuficiente',
    texto: e.dados.motivo || 'Um dos produtos não tinha estoque suficiente.',
  }),
  'pagamento.aprovado': (e) => ({
    assunto: 'Pagamento aprovado: pedido confirmado',
    texto: `Pagamento de ${reais(e.dados.valor)} aprovado (transação ${e.dados.codigoTransacao || '-'}). Seu pedido está confirmado.`,
  }),
  'pagamento.recusado': (e) => ({
    assunto: 'Pagamento recusado: pedido cancelado',
    texto: `O pagamento de ${reais(e.dados.valor)} não foi aprovado. Motivo: ${e.dados.motivo || 'não informado'}. Nenhum valor foi cobrado e o pedido foi cancelado.`,
  }),
  'pagamento.estornado': (e) => ({
    assunto: 'Estorno realizado',
    texto: `Estornamos ${reais(e.dados.valor)} (transação ${e.dados.codigoTransacao || '-'}). Motivo: ${e.dados.motivo || 'pedido cancelado'}. O valor volta para o seu cartão ou conta.`,
  }),
  'pedido.cancelado': () => ({
    assunto: 'Pedido cancelado',
    texto: 'Seu pedido foi cancelado a seu pedido. Se algo já tiver sido cobrado, o estorno será feito e você receberá outro e-mail.',
  }),
};

async function notificar(evento) {
  if (enviado.get(evento.id)) return; // idempotência: evento repetido não manda o mesmo e-mail duas vezes
  if (!evento.dados.clienteEmail) {
    console.log(`Sem e-mail no evento ${evento.tipo} pedido=${evento.pedidoId} correlationId=${evento.correlationId}`);
    return;
  }
  const { assunto, texto } = MENSAGENS[evento.tipo](evento);
  await smtp.sendMail({
    from: 'Loja <loja@example.com>', to: evento.dados.clienteEmail,
    messageId: `<${evento.id}@ecommerce.local>`,
    subject: assunto,
    text: `Pedido ${evento.pedidoId}\n${texto}\ncorrelationId=${evento.correlationId}`,
  });
  registrar.run(evento.id, new Date().toISOString());
  console.log(`E-mail "${assunto}" enviado pedido=${evento.pedidoId} correlationId=${evento.correlationId}`);
}

// GET /health -> { servico, status, dependencias }. O notificacoes não tem rota no Kong:
// este endpoint existe só para o healthcheck do Docker (porta 3000 interna, nada publicado).
// Sem Kafka, sem o SMTP (Mailpit) ou sem o próprio SQLite, não consegue trabalhar: 503.
const comLimite = (promessa, ms = 2000) => Promise.race([
  promessa, new Promise((_, rejeitar) => setTimeout(() => rejeitar(new Error('timeout')), ms)),
]);
async function saude() {
  let banco = 'ok';
  try { db.prepare('SELECT 1').get(); } catch { banco = 'fora do ar'; }
  const [kafkaStatus, smtpStatus] = await Promise.all([
    kafka.verificar(),
    comLimite(smtp.verify()).then(() => 'ok', () => 'fora do ar'),
  ]);
  const status = banco === 'ok' && kafkaStatus === 'ok' && smtpStatus === 'ok' ? 'ok' : 'fora do ar';
  return { servico: 'notificacoes', status, dependencias: { banco, kafka: kafkaStatus, smtp: smtpStatus } };
}
const servidorSaude = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    const corpo = await saude();
    res.writeHead(corpo.status === 'ok' ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(corpo));
  }
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ erro: 'Rota não encontrada.' }));
});

const handlers = Object.fromEntries(Object.keys(MENSAGENS).map((tipo) => [tipo, notificar]));
smtp.verify().then(() => kafka.iniciar(['pedidos', 'estoque', 'pagamentos'], handlers))
  .then(() => servidorSaude.listen(Number(process.env.PORT) || 3000, '0.0.0.0'))
  .catch((erro) => { console.error(erro.message); process.exit(1); });
async function encerrar() { servidorSaude.close(); await kafka.fechar(); smtp.close(); db.close(); process.exit(0); }
process.once('SIGTERM', encerrar);
process.once('SIGINT', encerrar);
