const express = require('express');
const { pool } = require('./db');
const { tratadorDeErros } = require('./erros');
const { identificar } = require('./identidade');
const { router: rotasCarrinho } = require('./rotas/carrinho');
const { router: rotasPedidos } = require('./rotas/pedidos');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

// Log com o X-Request-Id que o gateway gerou: o mesmo id aparece no Kong, aqui e no catálogo.
app.use((req, res, next) => {
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} | x-request-id=${req.get('x-request-id') || '-'}`);
  });
  next();
});

// GET /health -> 200 serviço e banco ok (no gateway: GET /health/pedidos)
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ servico: 'pedidos', status: 'ok', banco: 'ok' });
  } catch {
    res.status(503).json({ servico: 'pedidos', status: 'erro', banco: 'indisponível' });
  }
});

// Todas as rotas de carrinho e pedidos são "logado": exigem a identidade que o Kong injeta.
app.use('/carrinho', identificar, rotasCarrinho);
app.use('/pedidos', identificar, rotasPedidos);

app.use((req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));
app.use(tratadorDeErros);

module.exports = { app };
