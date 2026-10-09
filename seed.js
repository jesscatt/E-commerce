const bcrypt = require('bcrypt');

// Seed exigido na página 7 do material. Rodar várias vezes não cria duplicatas.
async function executarSeed(cliente) {
  const contas = [
    { nome: 'Administrador da Loja', email: 'admin@loja.com', senha: 'admin123', perfil: 'admin' },
    { nome: 'Cliente da Loja', email: 'cliente@loja.com', senha: 'cliente123', perfil: 'cliente' },
  ];

  for (const conta of contas) {
    const senhaHash = await bcrypt.hash(conta.senha, 12);
    await cliente.query(
      `INSERT INTO usuarios (nome, email, senha_hash, perfil)
       VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING`,
      [conta.nome, conta.email, senhaHash, conta.perfil]
    );
  }

  const { rows } = await cliente.query('SELECT id FROM usuarios WHERE email=$1', ['cliente@loja.com']);
  const clienteId = rows[0].id;
  await cliente.query(
    `INSERT INTO enderecos (usuario_id, apelido, cep, logradouro, numero, complemento, cidade, uf, principal)
     SELECT $1, 'Casa', '97000000', 'Rua Exemplo', '100', NULL, 'Santa Maria', 'RS', true
     WHERE NOT EXISTS (
       SELECT 1 FROM enderecos WHERE usuario_id=$1 AND apelido='Casa'
     )`,
    [clienteId]
  );
}

module.exports = { executarSeed };
