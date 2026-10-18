// Validação feita pela API; as restrições SQL são uma proteção adicional.
function texto(valor, minimo = 1, maximo = 150) {
  return typeof valor === 'string' && valor.trim().length >= minimo && valor.trim().length <= maximo;
}

function emailNormalizado(valor) {
  return typeof valor === 'string' ? valor.trim().toLowerCase() : '';
}

function emailValido(valor) {
  return valor.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(valor);
}

function senhaValida(valor) {
  return typeof valor === 'string' && valor.length >= 8 && Buffer.byteLength(valor, 'utf8') <= 72;
}

function validarUsuario(body, { atualizacao = false } = {}) {
  const dados = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const erros = [];
  const nome = typeof dados.nome === 'string' ? dados.nome.trim() : '';
  const email = emailNormalizado(dados.email);
  if (!texto(nome, 2)) erros.push('nome deve ter entre 2 e 150 caracteres');
  if (!emailValido(email)) erros.push('email inválido ou ausente');
  if (!atualizacao || dados.senha !== undefined) {
    if (!senhaValida(dados.senha)) erros.push('senha deve ter pelo menos 8 caracteres e até 72 bytes');
  }
  return { erros, valor: { nome, email, senha: dados.senha } };
}

function validarEndereco(body) {
  const dados = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const erros = [];
  const cep = typeof dados.cep === 'string' ? dados.cep.replace(/\D/g, '') : '';
  const uf = typeof dados.uf === 'string' ? dados.uf.trim().toUpperCase() : '';
  const apelido = typeof dados.apelido === 'string' ? dados.apelido.trim() : null;
  const logradouro = typeof dados.logradouro === 'string' ? dados.logradouro.trim() : '';
  const cidade = typeof dados.cidade === 'string' ? dados.cidade.trim() : '';
  const numero = typeof dados.numero === 'string' ? dados.numero.trim() : dados.numero == null ? null : String(dados.numero);
  const complemento = typeof dados.complemento === 'string' ? dados.complemento.trim() : null;
  const principal = dados.principal === undefined ? false : dados.principal;

  if (!/^\d{8}$/.test(cep)) erros.push('cep deve conter 8 dígitos');
  if (!texto(logradouro, 2, 200)) erros.push('logradouro inválido');
  if (!texto(cidade, 2, 100)) erros.push('cidade inválida');
  if (!/^[A-Z]{2}$/.test(uf)) erros.push('uf deve conter 2 letras');
  if (apelido !== null && apelido.length > 80) erros.push('apelido muito longo');
  if (numero !== null && numero.length > 30) erros.push('numero muito longo');
  if (complemento !== null && complemento.length > 200) erros.push('complemento muito longo');
  if (typeof principal !== 'boolean') erros.push('principal deve ser verdadeiro ou falso');

  return { erros, valor: { apelido, cep, logradouro, numero, complemento, cidade, uf, principal } };
}

function uuidValido(valor) {
  return typeof valor === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(valor);
}

module.exports = { emailNormalizado, validarUsuario, validarEndereco, uuidValido };
