const { app } = require('./app');
const { pool } = require('./db');

const PORT = Number(process.env.PORT) || 3000;

const servidor = app.listen(PORT, '0.0.0.0', () => {
  console.log(`pedidos ouvindo na porta ${PORT}`);
});

function encerrar() {
  servidor.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on('SIGTERM', encerrar);
process.on('SIGINT', encerrar);
