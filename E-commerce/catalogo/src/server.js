const express = require('express');
const { conectar, criarIndices, getDb, fechar } = require('./db');
const eventos = require('./eventos');
const cache = require('./cache');
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
  if (req.path === '/health') return next(); // o Docker chama a cada 10 s: fora do log
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} | x-request-id=${req.get('x-request-id') || '-'}`);
  });
  next();
});

// As rotas de admin (POST, PUT, PATCH, DELETE) são protegidas pelo Kong: jwt + acl allow [admin].
// O catálogo não sabe o que é JWT; só o gateway alcança este serviço.
app.use('/produtos', rotasProdutos);
app.use('/categorias', rotasCategorias);

// GET /health -> { servico, status, dependencias } (no gateway: GET /health/catalogo)
//   Mongo ou Kafka fora -> "fora do ar", 503
//   Redis fora          -> "degradado", 200: o cache só acelera; a vitrine continua direto no Mongo (OFF)
app.get('/health', async (req, res) => {
  const [banco, kafka, cacheStatus] = await Promise.all([
    Promise.race([
      getDb().command({ ping: 1 }).then(() => 'ok'),
      new Promise((resolver) => setTimeout(() => resolver('fora do ar'), 2000)),
    ]).catch(() => 'fora do ar'),
    eventos.verificarKafka(),
    cache.status(),
  ]);
  let status = 'ok';
  if (banco !== 'ok' || kafka !== 'ok') status = 'fora do ar';
  else if (cacheStatus !== 'ok') status = 'degradado';
  res.status(status === 'fora do ar' ? 503 : 200).json({
    servico: 'catalogo', status, dependencias: { banco, kafka, cache: cacheStatus },
  });
});

// Qualquer rota que não existe
app.use((req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));

app.use(tratadorDeErros);

async function iniciar() {
  await conectar();
  await criarIndices();
  await eventos.iniciar();
  const servidor = app.listen(PORT, () => console.log(`catalogo ouvindo na porta ${PORT}`));
  const encerrar = () => servidor.close(async () => {
    await eventos.fechar();
    await cache.fechar();
    await fechar();
    process.exit(0);
  });
  process.once('SIGTERM', encerrar);
  process.once('SIGINT', encerrar);
}

iniciar().catch((err) => {
  console.error('Falha ao iniciar o catalogo:', err.message);
  process.exit(1);
});
