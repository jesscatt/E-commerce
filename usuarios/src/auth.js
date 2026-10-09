const jwt = require('jsonwebtoken');
const { jwtSecret } = require('./config');

function autenticar(req, res, next) {
  const cabecalho = req.headers.authorization || '';
  const encontrado = /^Bearer (\S+)$/i.exec(cabecalho);
  if (!encontrado) return res.status(401).json({ erro: 'Token ausente ou inválido.' });
  try {
    const payload = jwt.verify(encontrado[1], jwtSecret(), { algorithms: ['HS256'] });
    if (!payload.id || !payload.email || !['admin', 'cliente'].includes(payload.perfil)) {
      return res.status(401).json({ erro: 'Token inválido.' });
    }
    req.usuario = { id: payload.id, email: payload.email, perfil: payload.perfil };
    next();
  } catch {
    return res.status(401).json({ erro: 'Token inválido ou expirado.' });
  }
}

function somenteAdmin(req, res, next) {
  if (req.usuario.perfil !== 'admin') return res.status(403).json({ erro: 'Acesso restrito a administradores.' });
  next();
}

module.exports = { autenticar, somenteAdmin };
