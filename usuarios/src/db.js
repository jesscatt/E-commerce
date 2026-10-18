require('./config');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || '5432'),
  database: process.env.PGDATABASE || 'usuarios_db',
  user: process.env.PGUSER || 'loja',
  password: process.env.PGPASSWORD,
  connectionTimeoutMillis: 3000,
});

pool.on('error', (erro) => {
  console.error('Erro inesperado na conexão ociosa com PostgreSQL:', erro);
});

module.exports = { pool };
