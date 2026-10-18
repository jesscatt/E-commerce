// Um formato de erro para todos: { "erro": "...", "detalhes": [...] }
// Nunca devolvemos stack trace nem mensagem do banco para o cliente.

class ErroHttp extends Error {
  constructor(status, erro, detalhes) {
    super(erro);
    this.status = status;
    this.detalhes = detalhes;
  }
}

const erros = {
  dadosInvalidos: (detalhes) => new ErroHttp(400, 'Dados inválidos.', detalhes),
  naoEncontrado: (msg = 'Recurso não encontrado.') => new ErroHttp(404, msg),
  conflito: (msg) => new ErroHttp(409, msg),
};

// Código 11000 = violação de índice único no Mongo (sku ou slug repetido).
function ehChaveDuplicada(err) {
  return err && err.code === 11000;
}

// Middleware final do Express: transforma qualquer erro no formato padrão.
function tratadorDeErros(err, req, res, next) {
  // JSON mal formado no corpo da requisição
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ erro: 'Dados inválidos.', detalhes: ['corpo da requisição não é um JSON válido'] });
  }

  if (err instanceof ErroHttp) {
    const corpo = { erro: err.message };
    if (err.detalhes && err.detalhes.length) corpo.detalhes = err.detalhes;
    return res.status(err.status).json(corpo);
  }

  console.error(err); // o detalhe fica no log, não na resposta
  return res.status(500).json({ erro: 'Erro interno no servidor.' });
}

module.exports = { ErroHttp, erros, ehChaveDuplicada, tratadorDeErros };
