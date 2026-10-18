// pedidos pergunta ao catálogo direto pela rede interna do Docker, sem passar pelo gateway:
// o gateway é a porta de fora. Uma chamada só para todos os produtos (?ids=a,b,c).
const { CatalogoIndisponivel } = require('./erros');

const CATALOGO_URL = process.env.CATALOGO_URL || 'http://catalogo:3000';
// Sem timeout, um catálogo travado trava o checkout junto.
const TIMEOUT_MS = Number(process.env.CATALOGO_TIMEOUT_MS) || 3000;

// Devolve um Map produto_id -> produto. Produto que não existe simplesmente não aparece.
async function buscarProdutos(ids, requestId) {
  if (!ids.length) return new Map();

  const url = `${CATALOGO_URL}/produtos?ids=${ids.map(encodeURIComponent).join(',')}`;
  try {
    const resposta = await fetch(url, {
      headers: requestId ? { 'x-request-id': requestId } : {},
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resposta.ok) throw new Error(`catálogo respondeu ${resposta.status}`);
    const lista = await resposta.json();
    return new Map(lista.map((produto) => [produto.id, produto]));
  } catch (erro) {
    console.error(`Catálogo indisponível | x-request-id=${requestId || '-'}: ${erro.message}`);
    throw new CatalogoIndisponivel();
  }
}

module.exports = { buscarProdutos };
