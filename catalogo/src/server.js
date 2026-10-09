const express = require('express');
const { conectar, criarIndices, getDb } = require('./db');
const { tratadorDeErros } = require('./erros');
const rotasProdutos = require('./rotas/produtos');
const rotasCategorias = require('./rotas/categorias');

const PORT = Number(process.env.PORT) || 3002;

const app = express();
app.use(express.json());

// Rotas de admin ficam abertas por enquanto: validar o token é trabalho do gateway (próxima aula).
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
