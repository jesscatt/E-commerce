// A partir da aula do gateway, quem valida o JWT é o Kong.
// Ele apaga os X-User-* que vierem de fora e preenche com os dados do token.
// O serviço só lê os cabeçalhos: confia neles porque só o gateway alcança o serviço
// (a porta do usuarios não é mais publicada no docker-compose).
const { uuidValido } = require('./validacao');

const PERFIS = ['admin', 'cliente'];

function autenticar(req, res, next) {
  const id = req.get('x-user-id');
  const email = req.get('x-user-email');
  const perfil = req.get('x-user-role');

  // Defesa extra: se a requisição chegou sem identidade, não passou pelo jwt do gateway.
  if (!uuidValido(id) || !email || !PERFIS.includes(perfil)) {
    return res.status(401).json({ erro: 'Faça login para continuar.' });
  }
  req.usuario = { id, email, perfil };
  next();
}

// O Kong já barra com 403 pelo acl; aqui é só uma segunda linha de defesa.
function somenteAdmin(req, res, next) {
  if (req.usuario.perfil !== 'admin') return res.status(403).json({ erro: 'Acesso restrito a administradores.' });
  next();
}

module.exports = { autenticar, somenteAdmin };
