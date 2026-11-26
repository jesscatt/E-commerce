const fs = require('node:fs');
const path = require('node:path');
const { pool } = require('../src/db');
const { executarSeed } = require('../seeds/seed');

const aguardar = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

async function conectarComTentativas() {
  for (let tentativa = 1; tentativa <= 20; tentativa += 1) {
    try {
      return await pool.connect();
    } catch (erro) {
      if (tentativa === 20) throw erro;
      console.log(`Aguardando PostgreSQL (${tentativa}/20)...`);
      await aguardar(1500);
    }
  }
}

async function iniciar() {
  const cliente = await conectarComTentativas();
  try {
    const sql = fs.readFileSync(path.join(__dirname, '../migrations/001_initial.sql'), 'utf8');
    await cliente.query('BEGIN');
    await cliente.query(sql);
    await executarSeed(cliente);
    await cliente.query('COMMIT');
    console.log('Tabelas e seed obrigatório preparados (sem duplicações).');
  } catch (erro) {
    await cliente.query('ROLLBACK');
    throw erro;
  } finally {
    cliente.release();
  }
}

iniciar()
  .catch((erro) => { console.error('Falha ao preparar banco:', erro); process.exitCode = 1; })
  .finally(() => pool.end());
