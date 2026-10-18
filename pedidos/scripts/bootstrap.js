// Cria as tabelas antes de a API subir. Pode rodar quantas vezes for preciso.
const fs = require('node:fs');
const path = require('node:path');
const { pool } = require('../src/db');

const aguardar = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

async function conectarComTentativas() {
  for (let tentativa = 1; tentativa <= 20; tentativa += 1) {
    try {
      return await pool.connect();
    } catch (erro) {
      if (tentativa === 20) throw erro;
      console.log(`Aguardando PostgreSQL do pedidos (${tentativa}/20)...`);
      await aguardar(1500);
    }
  }
}

async function iniciar() {
  const cliente = await conectarComTentativas();
  try {
    const sql = fs.readFileSync(path.join(__dirname, '../migrations/001_inicial.sql'), 'utf8');
    await cliente.query(sql);
    console.log('Tabelas do pedidos preparadas.');
  } finally {
    cliente.release();
  }
}

iniciar()
  .catch((erro) => { console.error('Falha ao preparar o banco do pedidos:', erro.message); process.exitCode = 1; })
  .finally(() => pool.end());
