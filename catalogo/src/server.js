const express = require('express');
const { conectar, criarIndices, getDb } = require('./db');
const { tratadorDeErros } = require('./erros');
const rotasProdutos = require('./rotas/produtos');
const rotasCategorias = require('./rotas/categorias');

const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.disable('x-powered-by');
app.use(express.json());

// Log de cada requisição com o X-Request-Id que o gateway gerou:
// o mesmo id aparece no log do Kong, do pedidos e daqui.
app.use((req, res, next) => {
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} | x-request-id=${req.get('x-request-id') || '-'}`);
  });
  next();
});

// As rotas de admin (POST, PUT, PATCH, DELETE) são protegidas pelo Kong: jwt + acl allow [admin].
// O catálogo não sabe o que é JWT; só o gateway alcança este serviço.
app.use('/produtos', rotasProdutos);
app.use('/categorias', rotasCategorias);

// GET /health -> 200 se o serviço e o banco respondem, 503 se o banco caiu
app.get('/health', async (req, res) => {
  try {
    await getDb().command({ ping: 1 });
    res.status(200).json({ servico: 'catalogo', status: 'ok', banco: 'ok' });
  } catch {
    res.status(503).json({ servico: 'catalogo', status: 'erro', banco: 'indisponível' });
  }
});

// Qualquer rota que não existe
app.use((req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));

app.use(tratadorDeErros);

async function iniciar() {
  await conectar();
  await criarIndices();
  app.listen(PORT, () => console.log(`catalogo ouvindo na porta ${PORT}`));
}

iniciar().catch((err) => {
  console.error('Falha ao iniciar o catalogo:', err.message);
  process.exit(1);
});
