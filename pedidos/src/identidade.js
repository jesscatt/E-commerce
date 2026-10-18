// Quem é o cliente? O Kong validou o JWT e injetou X-User-Id e X-User-Email.
// O pedidos não sabe o que é JWT: só lê os cabeçalhos. Confia neles porque só o gateway
// alcança este serviço (a porta 3000 do pedidos não é publicada no docker-compose).
const { erros } = require('./erros');
const { uuidValido } = require('./regras');

function identificar(req, res, next) {
  const id = req.get('x-user-id');
  const email = req.get('x-user-email');
  if (!uuidValido(id) || !email) return next(erros.naoAutenticado());
  req.usuario = { id, email, perfil: req.get('x-user-role') };
  next();
}

module.exports = { identificar };
