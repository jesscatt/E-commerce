const express = require('express');
const { pool } = require('./db');
const { verificarKafka } = require('./eventos');
const { tratadorDeErros } = require('./erros');
const { identificar } = require('./identidade');
const { router: rotasCarrinho } = require('./rotas/carrinho');
const { router: rotasPedidos } = require('./rotas/pedidos');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

// Log com o X-Request-Id que o gateway gerou: o mesmo id aparece no Kong, aqui e no catálogo.
app.use((req, res, next) => {
  if (req.path === '/health') return next(); // o Docker chama a cada 10 s: fora do log
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} | x-request-id=${req.get('x-request-id') || '-'}`);
  });
  next();
});

// GET /health -> { servico, status, dependencias } (no gateway: GET /health/pedidos)
// Banco e Kafka são essenciais: sem um deles, 503 (fora do ar).
// O catálogo NÃO entra aqui: se ele cair, o checkout responde 503, mas o pedidos continua de pé
// (um health que chama o health dos outros espalha a queda em cascata).
app.get('/health', async (req, res) => {
  const [banco, kafka] = await Promise.all([
    Promise.race([
      pool.query('SELECT 1').then(() => 'ok'),
      new Promise((resolver) => setTimeout(() => resolver('fora do ar'), 2000)),
    ]).catch(() => 'fora do ar'),
    verificarKafka(),
  ]);
  const status = banco === 'ok' && kafka === 'ok' ? 'ok' : 'fora do ar';
  res.status(status === 'ok' ? 200 : 503).json({ servico: 'pedidos', status, dependencias: { banco, kafka } });
});

// Todas as rotas de carrinho e pedidos são "logado": exigem a identidade que o Kong injeta.
app.use('/carrinho', identificar, rotasCarrinho);
app.use('/pedidos', identificar, rotasPedidos);

app.use((req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));
app.use(tratadorDeErros);

module.exports = { app };
