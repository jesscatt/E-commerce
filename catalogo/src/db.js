// Conexão única com o MongoDB, reaproveitada pelo serviço inteiro.
const { MongoClient } = require('mongodb');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const MONGO_DB = process.env.MONGO_DB || 'catalogo';

const client = new MongoClient(MONGO_URL);
let db;

async function conectar() {
  if (db) return db;
  await client.connect();
  db = client.db(MONGO_DB);
  return db;
}

// Índices pedidos no slide: sku único, categoria (para o filtro) e slug único.
async function criarIndices() {
  const banco = await conectar();
  await banco.collection('produtos').createIndex({ sku: 1 }, { unique: true });
  await banco.collection('produtos').createIndex({ categoria: 1 });
  await banco.collection('categorias').createIndex({ slug: 1 }, { unique: true });
}

function getDb() {
  if (!db) throw new Error('Banco ainda não conectado');
  return db;
}

async function fechar() {
  await client.close();
  db = undefined;
}

module.exports = { conectar, criarIndices, getDb, fechar };
