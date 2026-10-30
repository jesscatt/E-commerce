// Integração real: execute explicitamente com o Compose já iniciado.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:8080';
const checkout = {
  endereco_entrega: { cep: '97000-000', logradouro: 'Rua Teste', numero: '10', cidade: 'Santa Maria', uf: 'RS' },
  forma_pagamento: 'cartao', numero_cartao: '4111 1111 1111 1234',
};

async function requisitar(caminho, status, { metodo = 'GET', corpo, token, headers = {} } = {}) {
  const resposta = await fetch(`${base}${caminho}`, {
    method: metodo,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
    signal: AbortSignal.timeout(10000),
  });
  assert.ok([status].flat().includes(resposta.status), `${metodo} ${caminho}: esperado ${status}, recebido ${resposta.status}`);
  const texto = await resposta.text();
  return { dados: texto ? JSON.parse(texto) : null, headers: resposta.headers, status: resposta.status };
}

test('entrega da aula: gateway e pedidos', async (t) => {
  let cliente, outro, admin, produto, pedido;
  const pedidosCriados = new Set();
  const sufixo = randomUUID();
  const senha = randomUUID();

  async function cadastrar(nome) {
    const email = `${nome}-${sufixo}@example.com`;
    const { dados: usuario } = await requisitar('/usuarios', 201, {
      metodo: 'POST', corpo: { nome: `Teste ${nome}`, email, senha, perfil: 'admin' },
    });
    assert.equal(usuario.perfil, 'cliente', 'cadastro público não pode elevar o perfil');
    const { dados } = await requisitar('/auth/login', 200, { metodo: 'POST', corpo: { email, senha } });
    return { ...dados, id: usuario.id };
  }

  await t.test('três serviços e bancos respondem pelo gateway', async () => {
    for (const servico of ['usuarios', 'catalogo', 'pedidos']) {
      const { dados, headers } = await requisitar(`/health/${servico}`, 200);
      assert.equal(dados.banco, 'ok');
      assert.equal(dados.servico, servico);
      assert.ok(headers.get('x-request-id'));
    }
  });

  await t.test('cadastro, login e identidade autenticada vencem cabeçalhos forjados', async () => {
    cliente = await cadastrar('cliente');
    outro = await cadastrar('outro');
    const { dados } = await requisitar('/auth/login', 200, {
      metodo: 'POST', corpo: { email: 'admin@loja.com', senha: 'admin123' },
    });
    admin = dados;
    const perfil = await requisitar('/usuarios/me', 200, {
      token: cliente.token,
      headers: { 'x-user-id': outro.id, 'x-user-email': outro.usuario.email, 'x-user-role': 'admin' },
    });
    assert.equal(perfil.dados.id, cliente.id);
    assert.equal(perfil.dados.perfil, 'cliente');
  });

  // Os testes abaixo dependem das contas preparadas acima; falha no preparo é fatal.
  assert.ok(cliente && outro && admin, 'contas de teste precisam estar disponíveis');
  t.after(async () => {
    for (const id of pedidosCriados) {
      await requisitar(`/pedidos/${id}/cancelar`, 200, { metodo: 'POST', token: cliente.token });
    }
    if (produto) {
      // A API não oferece exclusão de usuários nem exclusão física de produtos.
      // Limpa também um item deixado por um teste interrompido antes da remoção.
      const carrinho = await requisitar('/carrinho', 200, { token: cliente.token });
      if (carrinho.dados.itens.some((item) => item.produto_id === produto.id)) {
        await requisitar(`/carrinho/itens/${produto.id}`, 204, { metodo: 'DELETE', token: cliente.token });
      }
      await requisitar(`/produtos/${produto.id}`, 204, { metodo: 'DELETE', token: admin.token });
    }
  });

  await t.test('JWT e ACL recusam acesso sem token, token falso e perfil cliente', async () => {
    const forjados = { 'x-user-id': cliente.id, 'x-user-email': cliente.usuario.email, 'x-user-role': 'admin' };
    for (const caminho of ['/usuarios', '/usuarios/me', '/carrinho', '/pedidos']) {
      await requisitar(caminho, 401, { headers: forjados });
    }
    await requisitar('/pedidos', 401, { token: 'token.falso.invalido' });
    await requisitar('/usuarios', 403, { token: cliente.token });
    await requisitar('/produtos', 401, { metodo: 'POST', corpo: {}, headers: forjados });
    await requisitar('/produtos', 403, { metodo: 'POST', corpo: {}, token: cliente.token });
    await requisitar('/usuarios', 200, { token: admin.token });
    await requisitar('/rota-inexistente', 404);
  });

  await t.test('correlation-id é criado nas recusas e preservado quando enviado', async () => {
    const recusada = await requisitar('/pedidos', 401);
    assert.ok(recusada.headers.get('x-request-id'));
    const id = randomUUID();
    const resposta = await requisitar('/pedidos', 200, { token: cliente.token, headers: { 'x-request-id': id } });
    assert.equal(resposta.headers.get('x-request-id'), id);
  });

  await t.test('admin cria produto de teste; catálogo público permite consulta em lote', async () => {
    const { dados: categorias } = await requisitar('/categorias', 200);
    assert.ok(categorias.length, 'seed de categorias obrigatório');
    const { dados } = await requisitar('/produtos', 201, {
      metodo: 'POST', token: admin.token,
      corpo: { sku: `TEST-${sufixo}`, nome: 'Produto de integração', categoria: categorias[0].slug, preco: 19.9, estoque: { disponivel: 3 } },
    });
    produto = dados;
    const lote = await requisitar(`/produtos?ids=${produto.id}`, 200);
    assert.equal(lote.dados[0].id, produto.id);
  });
  assert.ok(produto, 'produto de teste precisa estar disponível');

  await t.test('carrinho vazio, quantidade inválida e produto inexistente retornam os erros esperados', async () => {
    await requisitar('/pedidos', 400, { metodo: 'POST', corpo: checkout, token: cliente.token });
    await requisitar('/carrinho/itens', 400, { metodo: 'POST', corpo: { produto_id: produto.id, quantidade: 0 }, token: cliente.token });
    await requisitar('/carrinho/itens', 404, { metodo: 'POST', corpo: { produto_id: '000000000000000000000000' }, token: cliente.token });
  });

  await t.test('checkout aceita pedido, guarda histórico e apenas os últimos quatro dígitos', async () => {
    await requisitar('/carrinho/itens', 201, { metodo: 'POST', corpo: { produto_id: produto.id, quantidade: 2 }, token: cliente.token });
    const carrinho = await requisitar('/carrinho', 200, { token: cliente.token });
    assert.equal(carrinho.dados.total, 39.8);
    const aceito = await requisitar('/pedidos', 202, { metodo: 'POST', corpo: checkout, token: cliente.token });
    pedido = aceito.dados;
    pedidosCriados.add(pedido.id);
    assert.equal(aceito.headers.get('location'), `/pedidos/${pedido.id}`);
    assert.equal(pedido.status, 'AGUARDANDO_ESTOQUE');
    assert.equal(pedido.valor_total, 39.8);
    assert.equal(pedido.cartao_final, '1234');
    assert.equal(pedido.numero_cartao, undefined);
    assert.equal(pedido.itens[0].nome_produto, produto.nome);
    assert.equal(pedido.itens[0].preco_unitario, 19.9);
    assert.deepEqual((await requisitar('/carrinho', 200, { token: cliente.token })).dados, { itens: [], total: 0 });
    // Muda o preço atual e comprova que o pedido preserva o preço da compra.
    await requisitar(`/produtos/${produto.id}`, 200, { metodo: 'PUT', token: admin.token, corpo: { ...produto, preco: 29.9 } });
    const historico = await requisitar(`/pedidos/${pedido.id}`, 200, { token: cliente.token });
    assert.equal(historico.dados.valor_total, 39.8);
    assert.equal(historico.dados.itens[0].preco_unitario, 19.9);
  });
  assert.ok(pedido, 'checkout precisa ter criado um pedido');

  await t.test('outro usuário não consulta nem cancela o pedido; cancelamento repetido é conflito', async () => {
    await requisitar(`/pedidos/${pedido.id}`, 404, { token: outro.token });
    await requisitar(`/pedidos/${pedido.id}/cancelar`, 404, { metodo: 'POST', token: outro.token });
    assert.deepEqual((await requisitar('/pedidos', 200, { token: outro.token })).dados, []);
    await requisitar(`/pedidos/${pedido.id}/cancelar`, 200, { metodo: 'POST', token: cliente.token });
    pedidosCriados.delete(pedido.id);
    await requisitar(`/pedidos/${pedido.id}/cancelar`, 409, { metodo: 'POST', token: cliente.token });
  });

  await t.test('oito checkouts simultâneos consomem o mesmo carrinho uma única vez', async () => {
    const antes = (await requisitar('/pedidos', 200, { token: cliente.token })).dados.length;
    await requisitar('/carrinho/itens', 201, { metodo: 'POST', corpo: { produto_id: produto.id, quantidade: 1 }, token: cliente.token });
    const respostas = await Promise.all(Array.from({ length: 8 }, () =>
      requisitar('/pedidos', [202, 400], { metodo: 'POST', corpo: checkout, token: cliente.token })
    ));
    const aceitos = respostas.filter((resposta) => resposta.status === 202);
    for (const resposta of aceitos) pedidosCriados.add(resposta.dados.id);
    assert.equal(aceitos.length, 1, 'apenas um checkout deve criar pedido');
    for (const resposta of respostas.filter((r) => r.status === 400)) {
      assert.deepEqual(resposta.dados.detalhes, ['o carrinho está vazio']);
    }
    assert.equal((await requisitar('/pedidos', 200, { token: cliente.token })).dados.length, antes + 1);
    assert.deepEqual((await requisitar('/carrinho', 200, { token: cliente.token })).dados, { itens: [], total: 0 });
  });

  await t.test('estoque insuficiente cancela o pedido por evento e consome o carrinho', async () => {
    await requisitar('/carrinho/itens', 201, { metodo: 'POST', corpo: { produto_id: produto.id, quantidade: 4 }, token: cliente.token });
    const { dados } = await requisitar('/pedidos', 202, { metodo: 'POST', corpo: checkout, token: cliente.token });
    let resultado;
    for (let tentativa = 0; tentativa < 60; tentativa += 1) {
      resultado = (await requisitar(`/pedidos/${dados.id}`, 200, { token: cliente.token })).dados;
      if (resultado.status === 'CANCELADO') break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(resultado.status, 'CANCELADO');
    assert.ok(resultado.motivo_cancelamento);
    assert.deepEqual((await requisitar('/carrinho', 200, { token: cliente.token })).dados.itens, []);
    // Prepara um novo carrinho para os testes de indisponibilidade/remoção abaixo.
    await requisitar('/carrinho/itens', 201, { metodo: 'POST', corpo: { produto_id: produto.id, quantidade: 4 }, token: cliente.token });
  });

  await t.test('catálogo fora: checkout 503; carrinho e pedidos continuam acessíveis', {
    skip: process.env.TEST_CATALOGO_OUTAGE !== '1',
  }, async () => {
    const compose = (...args) => execFileSync('docker', ['compose', ...args], { cwd: require('node:path').join(__dirname, '..'), stdio: 'pipe', timeout: 60000 });
    try {
      compose('stop', 'catalogo');
      await requisitar('/pedidos', 503, { metodo: 'POST', corpo: checkout, token: cliente.token });
      const carrinho = await requisitar('/carrinho', 200, { token: cliente.token });
      assert.equal(carrinho.dados.total, null);
      assert.ok(carrinho.dados.aviso);
      assert.equal(carrinho.dados.itens[0].quantidade, 4);
      await requisitar('/pedidos', 200, { token: cliente.token });
    } finally {
      compose('start', 'catalogo');
      await esperarCatalogo();
    }
  });

  await t.test('item pode ser removido e remoção repetida retorna 404', async () => {
    await requisitar(`/carrinho/itens/${produto.id}`, 204, { metodo: 'DELETE', token: cliente.token });
    await requisitar(`/carrinho/itens/${produto.id}`, 404, { metodo: 'DELETE', token: cliente.token });
  });

  await t.test('login limita a dez tentativas por minuto por IP', async () => {
    // Consome o saldo da janela atual; roda por último para não bloquear os logins acima.
    for (let tentativa = 0; tentativa < 11; tentativa += 1) {
      const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'inexistente@example.com', senha: 'invalida' }), signal: AbortSignal.timeout(10000) });
      await r.text();
      if (r.status === 429) {
        assert.equal(r.headers.get('x-ratelimit-limit-minute'), '10');
        return;
      }
      assert.equal(r.status, 401);
    }
    assert.fail('o gateway não aplicou o limite de login');
  });
});

async function esperarCatalogo() {
  for (let tentativa = 0; tentativa < 30; tentativa += 1) {
    try {
      const r = await fetch(`${base}/health/catalogo`, { signal: AbortSignal.timeout(1000) });
      await r.text();
      if (r.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('O catálogo não voltou a responder após o teste de indisponibilidade.');
}
