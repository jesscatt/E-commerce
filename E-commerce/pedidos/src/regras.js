// Regras de negócio puras (sem banco, sem rede): fáceis de testar com node --test.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMAS_PAGAMENTO = ['cartao', 'pix', 'boleto'];
const STATUS_CANCELAVEIS = ['AGUARDANDO_ESTOQUE', 'AGUARDANDO_PAGAMENTO'];

function uuidValido(valor) {
  return typeof valor === 'string' && UUID.test(valor);
}

function ehObjeto(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function textoPreenchido(v, max = 200) {
  return typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;
}

// Dinheiro em centavos para não acumular erro de ponto flutuante (0.1 + 0.2).
const emCentavos = (valor) => Math.round(Number(valor) * 100);
const emReais = (centavos) => centavos / 100;

// POST /carrinho/itens: { produto_id, quantidade }
function validarItemCarrinho(body) {
  if (!ehObjeto(body)) return { erros: ['corpo deve ser um objeto JSON'] };
  const erros = [];
  const produtoId = typeof body.produto_id === 'string' ? body.produto_id.trim() : '';
  if (!produtoId) erros.push('produto_id é obrigatório');
  const quantidade = body.quantidade === undefined ? 1 : body.quantidade;
  if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > 99) {
    erros.push('quantidade deve ser um número inteiro entre 1 e 99');
  }
  return { erros, valor: { produtoId, quantidade } };
}

// POST /pedidos: { endereco_entrega: {...}, forma_pagamento, numero_cartao? }
function validarCheckout(body) {
  if (!ehObjeto(body)) return { erros: ['corpo deve ser um objeto JSON'] };
  const erros = [];

  const e = body.endereco_entrega;
  let endereco = null;
  if (!ehObjeto(e)) {
    erros.push('endereco_entrega é obrigatório (cep, logradouro, cidade, uf)');
  } else {
    const cep = typeof e.cep === 'string' ? e.cep.replace(/\D/g, '') : '';
    const uf = typeof e.uf === 'string' ? e.uf.trim().toUpperCase() : '';
    if (!/^\d{8}$/.test(cep)) erros.push('endereco_entrega.cep deve conter 8 dígitos');
    if (!textoPreenchido(e.logradouro)) erros.push('endereco_entrega.logradouro é obrigatório');
    if (!textoPreenchido(e.cidade, 100)) erros.push('endereco_entrega.cidade é obrigatória');
    if (!/^[A-Z]{2}$/.test(uf)) erros.push('endereco_entrega.uf deve conter 2 letras');
    endereco = {
      cep,
      logradouro: typeof e.logradouro === 'string' ? e.logradouro.trim() : '',
      numero: e.numero == null ? null : String(e.numero).trim(),
      complemento: typeof e.complemento === 'string' ? e.complemento.trim() : null,
      cidade: typeof e.cidade === 'string' ? e.cidade.trim() : '',
      uf,
    };
  }

  const forma = body.forma_pagamento;
  if (!FORMAS_PAGAMENTO.includes(forma)) {
    erros.push(`forma_pagamento deve ser uma destas: ${FORMAS_PAGAMENTO.join(', ')}`);
  }

  // Cartão: só os 4 últimos dígitos são gravados. O número inteiro nunca vai para o banco.
  let cartaoFinal = null;
  if (forma === 'cartao') {
    const numero = typeof body.numero_cartao === 'string' ? body.numero_cartao.replace(/[\s-]/g, '') : '';
    if (!/^\d{13,19}$/.test(numero)) erros.push('numero_cartao deve ter entre 13 e 19 dígitos');
    else cartaoFinal = numero.slice(-4);
  }

  return { erros, valor: { endereco, formaPagamento: forma, cartaoFinal } };
}

// Junta o carrinho com os produtos que o catálogo devolveu.
// Devolve os itens com preço e nome do momento da compra, o total e a lista do que
// não pode ser vendido (não existe ou foi desativado). Estoque é reservado por evento.
function montarPedido(carrinho, produtos) {
  const itens = [];
  const indisponiveis = [];
  let totalCentavos = 0;

  for (const { produto_id: produtoId, quantidade } of carrinho) {
    const p = produtos.get(produtoId);
    if (!p) {
      indisponiveis.push(`produto ${produtoId} não existe mais`);
      continue;
    }
    if (!p.ativo) {
      indisponiveis.push(`${p.nome} não está mais à venda`);
      continue;
    }
    // O preço é síncrono; disponibilidade é decidida na reserva por evento.
    const precoCentavos = emCentavos(p.preco);
    totalCentavos += precoCentavos * quantidade;
    itens.push({
      produto_id: produtoId,
      nome_produto: p.nome,
      preco_unitario: emReais(precoCentavos),
      quantidade,
    });
  }

  return { itens, total: emReais(totalCentavos), indisponiveis };
}

// GET /carrinho: mostra o carrinho com os preços atuais do catálogo.
function montarCarrinho(carrinho, produtos) {
  let totalCentavos = 0;
  const itens = carrinho.map(({ produto_id: produtoId, quantidade }) => {
    const p = produtos.get(produtoId);
    if (!p) {
      return { produto_id: produtoId, nome: null, preco_unitario: null, quantidade, subtotal: null, disponivel: false };
    }
    const precoCentavos = emCentavos(p.preco);
    totalCentavos += precoCentavos * quantidade;
    return {
      produto_id: produtoId,
      nome: p.nome,
      preco_unitario: emReais(precoCentavos),
      quantidade,
      subtotal: emReais(precoCentavos * quantidade),
      disponivel: Boolean(p.ativo) && (p.estoque?.disponivel ?? 0) >= quantidade,
    };
  });
  return { itens, total: emReais(totalCentavos) };
}

function podeCancelar(status) {
  return STATUS_CANCELAVEIS.includes(status);
}

module.exports = {
  uuidValido,
  validarItemCarrinho,
  validarCheckout,
  montarPedido,
  montarCarrinho,
  podeCancelar,
  FORMAS_PAGAMENTO,
  STATUS_CANCELAVEIS,
};
