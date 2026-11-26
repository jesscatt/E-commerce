// O mesmo formato de erro dos outros serviços: { "erro": "...", "detalhes": [...] }
// Nunca devolvemos stack trace nem mensagem do banco para o cliente.

class ErroHttp extends Error {
  constructor(status, erro, detalhes) {
    super(erro);
    this.status = status;
    this.detalhes = detalhes;
  }
}

// O catálogo não respondeu (fora do ar, travado ou com erro): vira 503.
class CatalogoIndisponivel extends ErroHttp {
  constructor() {
    super(503, 'Catálogo indisponível no momento. Tente novamente em instantes.');
  }
}

const erros = {
  naoAutenticado: () => new ErroHttp(401, 'Faça login para continuar.'),
  dadosInvalidos: (detalhes) => new ErroHttp(400, 'Dados inválidos.', detalhes),
  naoEncontrado: (msg) => new ErroHttp(404, msg),
  conflito: (msg, detalhes) => new ErroHttp(409, msg, detalhes),
};

function tratadorDeErros(err, req, res, next) {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ erro: 'Dados inválidos.', detalhes: ['corpo da requisição não é um JSON válido'] });
  }
  if (err instanceof ErroHttp) {
    const corpo = { erro: err.message };
    if (err.detalhes && err.detalhes.length) corpo.detalhes = err.detalhes;
    return res.status(err.status).json(corpo);
  }
  console.error(`Erro interno | x-request-id=${req.get('x-request-id') || '-'}:`, err);
  return res.status(500).json({ erro: 'Erro interno do servidor.' });
}

module.exports = { ErroHttp, CatalogoIndisponivel, erros, tratadorDeErros };
