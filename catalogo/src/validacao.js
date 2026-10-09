// Validação no serviço (o banco é só a última linha de defesa).
// Cada função devolve uma lista de mensagens; lista vazia = tudo certo.

const SLUG_VALIDO = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function ehTextoPreenchido(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function ehObjeto(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function ehInteiroNaoNegativo(v) {
  return Number.isInteger(v) && v >= 0;
}

// Usado no POST e no PUT: o produto precisa vir inteiro.
function validarProduto(body) {
  const d = [];
  if (!ehObjeto(body)) return ['corpo deve ser um objeto JSON'];

  if (!ehTextoPreenchido(body.sku)) d.push('sku é obrigatório');
  if (!ehTextoPreenchido(body.nome)) d.push('nome é obrigatório');
  if (!ehTextoPreenchido(body.categoria)) d.push('categoria é obrigatória');

  if (body.preco === undefined || body.preco === null) d.push('preco é obrigatório');
  else if (typeof body.preco !== 'number' || !Number.isFinite(body.preco)) d.push('preco deve ser um número');
  else if (body.preco <= 0) d.push('preco deve ser maior que zero');

  if (body.ativo !== undefined && typeof body.ativo !== 'boolean') d.push('ativo deve ser true ou false');
  if (body.atributos !== undefined && !ehObjeto(body.atributos)) d.push('atributos deve ser um objeto');

  if (body.estoque !== undefined) {
    if (!ehObjeto(body.estoque)) d.push('estoque deve ser um objeto { disponivel, reservado }');
    else {
      const { disponivel = 0, reservado = 0 } = body.estoque;
      if (!ehInteiroNaoNegativo(disponivel)) d.push('estoque.disponivel deve ser um inteiro maior ou igual a zero');
      if (!ehInteiroNaoNegativo(reservado)) d.push('estoque.reservado deve ser um inteiro maior ou igual a zero');
    }
  }
  return d;
}

// Monta o documento só com os campos conhecidos (ignora lixo que vier no corpo).
function montarProduto(body) {
  return {
    sku: body.sku.trim().toUpperCase(),
    nome: body.nome.trim(),
    categoria: body.categoria.trim().toLowerCase(),
    preco: body.preco,
    ativo: body.ativo === undefined ? true : body.ativo,
    atributos: body.atributos || {},
    estoque: {
      disponivel: body.estoque?.disponivel ?? 0,
      reservado: body.estoque?.reservado ?? 0,
    },
  };
}

// PATCH /produtos/:id/estoque: { disponivel?, reservado? } com pelo menos um dos dois.
function validarEstoque(body) {
  const d = [];
  if (!ehObjeto(body)) return ['corpo deve ser um objeto JSON'];
  const { disponivel, reservado } = body;
  if (disponivel === undefined && reservado === undefined) {
    return ['informe disponivel e/ou reservado'];
  }
  for (const [campo, valor] of [['disponivel', disponivel], ['reservado', reservado]]) {
    if (valor === undefined) continue;
    if (!Number.isInteger(valor)) d.push(`${campo} deve ser um número inteiro`);
    else if (valor < 0) d.push(`${campo} não pode ser negativo`);
  }
  return d;
}

function validarCategoria(body) {
  const d = [];
  if (!ehObjeto(body)) return ['corpo deve ser um objeto JSON'];
  if (!ehTextoPreenchido(body.nome)) d.push('nome é obrigatório');
  if (!ehTextoPreenchido(body.slug)) d.push('slug é obrigatório');
  else if (!SLUG_VALIDO.test(body.slug.trim())) d.push('slug deve ter só letras minúsculas, números e hífens (ex.: eletronicos)');
  return d;
}

module.exports = { validarProduto, montarProduto, validarEstoque, validarCategoria };
