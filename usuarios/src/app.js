const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('./db');
const { jwtSecret } = require('./config');
const { autenticar, somenteAdmin } = require('./auth');
const { emailNormalizado, validarUsuario, validarEndereco, uuidValido } = require('./validacao');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

const usuarioPublico = (linha) => ({
  id: linha.id,
  nome: linha.nome,
  email: linha.email,
  perfil: linha.perfil,
  criado_em: linha.criado_em,
});
const asyncRota = (funcao) => (req, res, next) => Promise.resolve(funcao(req, res, next)).catch(next);
const erroValidacao = (res, detalhes) => res.status(400).json({ erro: 'Dados inválidos.', detalhes });

app.get('/health', asyncRota(async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok', servico: 'usuarios', banco: 'ok' });
  } catch {
    res.status(503).json({ erro: 'Serviço temporariamente indisponível.' });
  }
}));

// Login (público): senha nunca é devolvida.
app.post('/auth/login', asyncRota(async (req, res) => {
  const email = emailNormalizado(req.body?.email);
  const senha = req.body?.senha;
  if (!email || typeof senha !== 'string') {
    return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });
  }
  const resultado = await pool.query(
    'SELECT id, nome, email, senha_hash, perfil, criado_em FROM usuarios WHERE email = $1',
    [email]
  );
  const linha = resultado.rows[0];
  if (!linha || !(await bcrypt.compare(senha, linha.senha_hash))) {
    return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });
  }
  const token = jwt.sign(
    { id: linha.id, email: linha.email, perfil: linha.perfil },
    jwtSecret(),
    { algorithm: 'HS256', expiresIn: '2h' }
  );
  res.status(200).json({ token, usuario: usuarioPublico(linha) });
}));

// Cadastro público: toda nova conta tem perfil cliente (não aceita admin no JSON).
app.post('/usuarios', asyncRota(async (req, res) => {
  const { erros, valor } = validarUsuario(req.body);
  if (erros.length) return erroValidacao(res, erros);
  const senhaHash = await bcrypt.hash(valor.senha, 12);
  try {
    const resultado = await pool.query(
      `INSERT INTO usuarios (nome, email, senha_hash, perfil)
       VALUES ($1, $2, $3, 'cliente')
       RETURNING id, nome, email, perfil, criado_em`,
      [valor.nome, valor.email, senhaHash]
    );
    return res.status(201).json(usuarioPublico(resultado.rows[0]));
  } catch (erro) {
    if (erro.code === '23505') return res.status(409).json({ erro: 'Este e-mail já está cadastrado.' });
    throw erro;
  }
}));

app.get('/usuarios/me', autenticar, asyncRota(async (req, res) => {
  const resultado = await pool.query(
    'SELECT id, nome, email, perfil, criado_em FROM usuarios WHERE id = $1',
    [req.usuario.id]
  );
  if (!resultado.rows.length) return res.status(401).json({ erro: 'Usuário não encontrado.' });
  res.status(200).json(usuarioPublico(resultado.rows[0]));
}));

app.put('/usuarios/me', autenticar, asyncRota(async (req, res) => {
  const { erros, valor } = validarUsuario(req.body, { atualizacao: true });
  if (erros.length) return erroValidacao(res, erros);
  const senhaHash = valor.senha === undefined ? null : await bcrypt.hash(valor.senha, 12);
  try {
    const resultado = await pool.query(
      `UPDATE usuarios SET nome=$1, email=$2,
       senha_hash=COALESCE($3, senha_hash)
       WHERE id=$4 RETURNING id, nome, email, perfil, criado_em`,
      [valor.nome, valor.email, senhaHash, req.usuario.id]
    );
    if (!resultado.rows.length) return res.status(401).json({ erro: 'Usuário não encontrado.' });
    return res.status(200).json(usuarioPublico(resultado.rows[0]));
  } catch (erro) {
    if (erro.code === '23505') return res.status(409).json({ erro: 'Este e-mail já está cadastrado.' });
    throw erro;
  }
}));

app.get('/usuarios/me/enderecos', autenticar, asyncRota(async (req, res) => {
  const resultado = await pool.query(
    `SELECT id, usuario_id, apelido, cep, logradouro, numero, complemento, cidade, uf, principal
     FROM enderecos WHERE usuario_id=$1 ORDER BY principal DESC, apelido NULLS LAST, id`,
    [req.usuario.id]
  );
  res.status(200).json(resultado.rows);
}));

app.post('/usuarios/me/enderecos', autenticar, asyncRota(async (req, res) => {
  const { erros, valor } = validarEndereco(req.body);
  if (erros.length) return erroValidacao(res, erros);
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    if (valor.principal) {
      await cliente.query('UPDATE enderecos SET principal=false WHERE usuario_id=$1', [req.usuario.id]);
    }
    const resultado = await cliente.query(
      `INSERT INTO enderecos (usuario_id, apelido, cep, logradouro, numero, complemento, cidade, uf, principal)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, usuario_id, apelido, cep, logradouro, numero, complemento, cidade, uf, principal`,
      [req.usuario.id, valor.apelido, valor.cep, valor.logradouro, valor.numero,
        valor.complemento, valor.cidade, valor.uf, valor.principal]
    );
    await cliente.query('COMMIT');
    return res.status(201).json(resultado.rows[0]);
  } catch (erro) {
    await cliente.query('ROLLBACK');
    if (erro.code === '23503') return res.status(401).json({ erro: 'Usuário não encontrado.' });
    throw erro;
  } finally {
    cliente.release();
  }
}));

app.delete('/usuarios/me/enderecos/:id', autenticar, asyncRota(async (req, res) => {
  if (!uuidValido(req.params.id)) return res.status(404).json({ erro: 'Endereço não encontrado.' });
  const resultado = await pool.query(
    'DELETE FROM enderecos WHERE id=$1 AND usuario_id=$2 RETURNING id',
    [req.params.id, req.usuario.id]
  );
  if (!resultado.rows.length) return res.status(404).json({ erro: 'Endereço não encontrado.' });
  return res.status(204).end();
}));

app.get('/usuarios', autenticar, somenteAdmin, asyncRota(async (req, res) => {
  const resultado = await pool.query(
    'SELECT id, nome, email, perfil, criado_em FROM usuarios ORDER BY criado_em DESC, id'
  );
  res.status(200).json(resultado.rows.map(usuarioPublico));
}));

app.use((req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));

app.use((erro, req, res, next) => {
  if (erro instanceof SyntaxError && erro.status === 400 && 'body' in erro) {
    return res.status(400).json({ erro: 'JSON inválido.' });
  }
  console.error('Erro interno:', erro);
  return res.status(500).json({ erro: 'Erro interno do servidor.' });
});

module.exports = { app };
