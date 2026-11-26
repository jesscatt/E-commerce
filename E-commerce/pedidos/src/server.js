const { app } = require('./app');
const { pool } = require('./db');
const eventos = require('./eventos');

const PORT = Number(process.env.PORT) || 3000;

let servidor;
eventos.iniciar().then(() => {
  servidor = app.listen(PORT, '0.0.0.0', () => console.log(`pedidos ouvindo na porta ${PORT}`));
}).catch((erro) => { console.error('Falha ao iniciar eventos:', erro.message); process.exit(1); });

function encerrar() {
  servidor?.close(async () => {
    await eventos.fechar();
    await pool.end();
    process.exit(0);
  });
}
process.on('SIGTERM', encerrar);
process.on('SIGINT', encerrar);
