const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  validarItemCarrinho, validarCheckout, montarPedido, montarCarrinho, podeCancelar, uuidValido,
} = require('../src/regras');

const produto = (id, extra = {}) => ({
  id, nome: `Produto ${id}`, preco: 10, ativo: true, estoque: { disponivel: 5, reservado: 0 }, ...extra,
});

test('item do carrinho: quantidade padrão é 1', () => {
  const { erros, valor } = validarItemCarrinho({ produto_id: 'abc' });
  assert.deepEqual(erros, []);
  assert.equal(valor.quantidade, 1);
});

test('item do carrinho: quantidade zero, negativa ou quebrada é 400', () => {
  for (const quantidade of [0, -1, 1.5, '2', 100]) {
    assert.ok(validarItemCarrinho({ produto_id: 'abc', quantidade }).erros.length, `aceitou ${quantidade}`);
  }
  assert.ok(validarItemCarrinho({ quantidade: 1 }).erros.includes('produto_id é obrigatório'));
});

const enderecoOk = { cep: '97000-000', logradouro: 'Rua A', cidade: 'Santa Maria', uf: 'rs' };

test('checkout com pix e endereço válido', () => {
  const { erros, valor } = validarCheckout({ endereco_entrega: enderecoOk, forma_pagamento: 'pix' });
  assert.deepEqual(erros, []);
  assert.equal(valor.endereco.cep, '97000000');
  assert.equal(valor.endereco.uf, 'RS');
  assert.equal(valor.cartaoFinal, null);
});

test('checkout com cartão guarda só os 4 últimos dígitos', () => {
  const { erros, valor } = validarCheckout({
    endereco_entrega: enderecoOk, forma_pagamento: 'cartao', numero_cartao: '4111 1111 1111 1234',
  });
  assert.deepEqual(erros, []);
  assert.equal(valor.cartaoFinal, '1234');
  assert.ok(!JSON.stringify(valor).includes('4111'));
});

test('checkout inválido lista os problemas', () => {
  const { erros } = validarCheckout({ forma_pagamento: 'cheque' });
  assert.ok(erros.some((e) => e.startsWith('endereco_entrega')));
  assert.ok(erros.some((e) => e.startsWith('forma_pagamento')));
  assert.ok(validarCheckout({ endereco_entrega: enderecoOk, forma_pagamento: 'cartao' }).erros
    .some((e) => e.startsWith('numero_cartao')));
});

test('montarPedido copia nome e preço e soma em centavos', () => {
  const produtos = new Map([
    ['a', produto('a', { preco: 0.1 })],
    ['b', produto('b', { preco: 0.2 })],
  ]);
  const { itens, total, indisponiveis } = montarPedido(
    [{ produto_id: 'a', quantidade: 1 }, { produto_id: 'b', quantidade: 1 }], produtos,
  );
  assert.deepEqual(indisponiveis, []);
  assert.equal(total, 0.3); // e não 0.30000000000000004
  assert.equal(itens[0].nome_produto, 'Produto a');
  assert.equal(itens[0].preco_unitario, 0.1);
});

test('montarPedido rejeita sumido/inativo e deixa a reserva decidir a falta de estoque', () => {
  const produtos = new Map([
    ['inativo', produto('inativo', { ativo: false })],
    ['pouco', produto('pouco', { estoque: { disponivel: 1, reservado: 0 } })],
  ]);
  const { itens, indisponiveis } = montarPedido([
    { produto_id: 'sumiu', quantidade: 1 },
    { produto_id: 'inativo', quantidade: 1 },
    { produto_id: 'pouco', quantidade: 2 },
  ], produtos);
  assert.equal(itens.length, 1);
  assert.equal(itens[0].produto_id, 'pouco');
  assert.equal(indisponiveis.length, 2);
});

test('montarCarrinho calcula subtotal e marca o que não tem estoque', () => {
  const produtos = new Map([['a', produto('a', { preco: 2499.9 })]]);
  const { itens, total } = montarCarrinho([
    { produto_id: 'a', quantidade: 2 },
    { produto_id: 'sumiu', quantidade: 1 },
  ], produtos);
  assert.equal(itens[0].subtotal, 4999.8);
  assert.equal(itens[0].disponivel, true);
  assert.equal(itens[1].disponivel, false);
  assert.equal(total, 4999.8);
});

test('só cancela antes de pagar', () => {
  assert.equal(podeCancelar('AGUARDANDO_ESTOQUE'), true);
  assert.equal(podeCancelar('AGUARDANDO_PAGAMENTO'), true);
  assert.equal(podeCancelar('PAGO'), false);
  assert.equal(podeCancelar('CANCELADO'), false);
});

test('uuidValido', () => {
  assert.equal(uuidValido('05be7f0d-cb73-4c8e-9a1b-2f3d4e5f6a7b'), true);
  assert.equal(uuidValido('1 OR 1=1'), false);
  assert.equal(uuidValido(undefined), false);
});
