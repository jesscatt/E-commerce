const { app } = require('./app');
const { jwtSecret } = require('./config');
const { pool } = require('./db');

jwtSecret();
const PORT = Number(process.env.PORT || 3001);
const servidor = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Microserviço de usuários disponível na porta ${PORT}`);
});

async function encerrar() {
  servidor.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on('SIGTERM', encerrar);
process.on('SIGINT', encerrar);
