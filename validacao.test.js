const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validarUsuario, validarEndereco, emailNormalizado, uuidValido } = require('../src/validacao');

test('cadastro válido normaliza o e-mail e o nome', () => {
  const { erros, valor } = validarUsuario({ nome: ' Ana ', email: ' ANA@EXEMPLO.COM ', senha: 'segredo123' });
  assert.deepEqual(erros, []);
  assert.equal(valor.email, 'ana@exemplo.com');
  assert.equal(valor.nome, 'Ana');
});

test('cadastro rejeita dados obrigatórios ausentes', () => {
  assert.ok(validarUsuario({}).erros.length >= 3);
});

test('atualização não exige repetir a senha', () => {
  assert.deepEqual(validarUsuario({ nome: 'Ana', email: 'ana@email.com' }, { atualizacao: true }).erros, []);
});

test('senha maior que 72 bytes é rejeitada antes do bcrypt', () => {
  assert.ok(validarUsuario({ nome: 'Ana', email: 'ana@email.com', senha: '😀'.repeat(20) }).erros.length > 0);
});

test('endereço válido normaliza CEP e UF', () => {
  const { erros, valor } = validarEndereco({ cep: '97000-000', logradouro: 'Rua Teste', cidade: 'Santa Maria', uf: 'rs', principal: true });
  assert.deepEqual(erros, []);
  assert.equal(valor.cep, '97000000');
  assert.equal(valor.uf, 'RS');
});

test('endereço rejeita CEP/UF inválidos e principal não booleano', () => {
  assert.ok(validarEndereco({ cep: '123', logradouro: 'R', cidade: 'A', uf: 'XYZ', principal: 'sim' }).erros.length >= 4);
});

test('normalização e validação de UUID', () => {
  assert.equal(emailNormalizado(' A@B.COM '), 'a@b.com');
  assert.equal(uuidValido('77d52c80-35eb-4dce-80a4-2ce282d28c69'), true);
  assert.equal(uuidValido('nao-e-uuid'), false);
});
