const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const { dirname } = require('node:path');
const nodemailer = require('nodemailer');
const { criarKafka } = require('./kafka');

const arquivo = process.env.NOTIFICACOES_DB || '/data/notificacoes.sqlite';
mkdirSync(dirname(arquivo), { recursive: true });
const db = new DatabaseSync(arquivo);
db.exec('CREATE TABLE IF NOT EXISTS enviados (evento_id TEXT PRIMARY KEY, enviado_em TEXT NOT NULL)');
const enviado = db.prepare('SELECT 1 FROM enviados WHERE evento_id = ?');
const registrar = db.prepare('INSERT OR IGNORE INTO enviados VALUES (?, ?)');
const smtp = nodemailer.createTransport({ host: process.env.SMTP_HOST || 'mailpit', port: Number(process.env.SMTP_PORT || 1025), secure: false });
const kafka = criarKafka('notificacoes');

async function notificar(evento) {
  if (enviado.get(evento.id)) return;
  const insuficiente = evento.tipo === 'estoque.insuficiente';
  await smtp.sendMail({
    from: 'Loja <loja@example.com>', to: evento.dados.clienteEmail,
    messageId: `<${evento.id}@ecommerce.local>`,
    subject: insuficiente ? 'Pedido cancelado: estoque insuficiente' : 'Recebemos o seu pedido',
    text: `Pedido ${evento.pedidoId}\n${insuficiente ? evento.dados.motivo : 'Recebido! Estamos verificando o estoque.'}\ncorrelationId=${evento.correlationId}`,
  });
  registrar.run(evento.id, new Date().toISOString());
  console.log(`E-mail enviado pedido=${evento.pedidoId} correlationId=${evento.correlationId}`);
}

smtp.verify().then(() => kafka.iniciar(['pedidos', 'estoque'], {
  'pedido.criado': notificar, 'estoque.insuficiente': notificar,
})).catch((erro) => { console.error(erro.message); process.exit(1); });
async function encerrar() { await kafka.fechar(); smtp.close(); db.close(); process.exit(0); }
process.once('SIGTERM', encerrar);
process.once('SIGINT', encerrar);
