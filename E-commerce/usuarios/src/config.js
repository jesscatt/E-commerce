const path = require('node:path');
const dotenv = require('dotenv');

// Em execução local, lê o .env da raiz; no Docker, as variáveis chegam pelo Compose.
dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

function jwtSecret() {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 32) {
    throw new Error('JWT_SECRET deve conter pelo menos 32 caracteres.');
  }
  return value;
}

module.exports = { jwtSecret };
