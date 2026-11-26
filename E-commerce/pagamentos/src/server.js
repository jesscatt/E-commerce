const { criarApp } = require('./app');
const { pool } = require('./db');
const eventos = require('./eventos');

const PORT = Number(process.env.PORT) || 3000;

let servidor;
eventos.iniciar().then(() => {
  const app = criarApp({ estadoCircuito: eventos.estadoCircuito, verificarKafka: eventos.verificarKafka });
  servidor = app.listen(PORT, '0.0.0.0', () => console.log(`pagamentos ouvindo na porta ${PORT}`));
}).catch((erro) => { console.error('Falha ao iniciar pagamentos:', erro.message); process.exit(1); });

function encerrar() {
  const terminar = async () => {
    await eventos.fechar();
    await pool.end();
    process.exit(0);
  };
  if (servidor) servidor.close(terminar);
  else terminar();
}
process.on('SIGTERM', encerrar);
process.on('SIGINT', encerrar);
