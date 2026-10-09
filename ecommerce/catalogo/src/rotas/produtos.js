const express = require('express');
const { ObjectId } = require('mongodb');
const { getDb } = require('../db');
const { erros, ehChaveDuplicada } = require('../erros');
const { validarProduto, montarProduto, validarEstoque } = require('../validacao');

const router = express.Router();

// Express 4 não captura erro de função async sozinho; este wrapper repassa para o tratador.
const rota = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const produtos = () => getDb().collection('produtos');
const categorias = () => getDb().collection('categorias');

// Devolve "id" em vez de "_id" para quem consome a API.
function formatar(doc) {
  const { _id, ...resto } = doc;
  return { id: _id.toString(), ...resto };
}

// Id mal formado é tratado como "não existe" (404), não como erro do servidor.
function idOu404(id) {
  if (!ObjectId.isValid(id) || String(new ObjectId(id)) !== id) {
    throw erros.naoEncontrado('Produto não encontrado.');
  }
  return new ObjectId(id);
}

// Escapa caracteres especiais para a busca por texto não virar regex arbitrária.
function escaparRegex(texto) {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function garantirCategoriaExiste(slug) {
  const existe = await categorias().findOne({ slug });
  if (!existe) throw erros.dadosInvalidos([`categoria "${slug}" não existe`]);
}

// GET /produtos?categoria=&busca=  (público) -> só produtos ativos
router.get('/', rota(async (req, res) => {
  const filtro = { ativo: true };
  const { categoria, busca } = req.query;

  if (typeof categoria === 'string' && categoria.trim()) {
    filtro.categoria = categoria.trim().toLowerCase();
  }
  if (typeof busca === 'string' && busca.trim()) {
    filtro.nome = { $regex: escaparRegex(busca.trim()), $options: 'i' };
  }

  const lista = await produtos().find(filtro).sort({ nome: 1 }).toArray();
  res.status(200).json(lista.map(formatar));
}));

// GET /produtos/:id  (público)
router.get('/:id', rota(async (req, res) => {
  const doc = await produtos().findOne({ _id: idOu404(req.params.id) });
  if (!doc) throw erros.naoEncontrado('Produto não encontrado.');
  res.status(200).json(formatar(doc));
}));

// POST /produtos  (admin) -> 201 · 400 · 409 SKU já existe
router.post('/', rota(async (req, res) => {
  const detalhes = validarProduto(req.body);
  if (detalhes.length) throw erros.dadosInvalidos(detalhes);

  const novo = montarProduto(req.body);
  await garantirCategoriaExiste(novo.categoria);
  novo.criado_em = new Date();

  try {
    const { insertedId } = await produtos().insertOne(novo);
    res.status(201).json(formatar({ _id: insertedId, ...novo }));
  } catch (err) {
    if (ehChaveDuplicada(err)) throw erros.conflito('Este SKU já está cadastrado.');
    throw err;
  }
}));

// PUT /produtos/:id  (admin) -> substitui o produto inteiro · 200 · 400 · 404
router.put('/:id', rota(async (req, res) => {
  const _id = idOu404(req.params.id);
  const detalhes = validarProduto(req.body);
  if (detalhes.length) throw erros.dadosInvalidos(detalhes);

  const atual = await produtos().findOne({ _id });
  if (!atual) throw erros.naoEncontrado('Produto não encontrado.');

  const substituto = montarProduto(req.body);
  await garantirCategoriaExiste(substituto.categoria);
  substituto.criado_em = atual.criado_em;
  substituto.atualizado_em = new Date();

  try {
    await produtos().replaceOne({ _id }, substituto);
    res.status(200).json(formatar({ _id, ...substituto }));
  } catch (err) {
    if (ehChaveDuplicada(err)) throw erros.conflito('Este SKU já está cadastrado em outro produto.');
    throw err;
  }
}));

// PATCH /produtos/:id/estoque  (admin) -> altera só o estoque · 200 · 400 estoque negativo · 404
router.patch('/:id/estoque', rota(async (req, res) => {
  const _id = idOu404(req.params.id);
  const detalhes = validarEstoque(req.body);
  if (detalhes.length) throw erros.dadosInvalidos(detalhes);

  const set = { atualizado_em: new Date() };
  if (req.body.disponivel !== undefined) set['estoque.disponivel'] = req.body.disponivel;
  if (req.body.reservado !== undefined) set['estoque.reservado'] = req.body.reservado;

  const doc = await produtos().findOneAndUpdate({ _id }, { $set: set }, { returnDocument: 'after' });
  if (!doc) throw erros.naoEncontrado('Produto não encontrado.');
  res.status(200).json(formatar(doc));
}));

// DELETE /produtos/:id  (admin) -> não apaga: marca ativo = false · 204 · 404
router.delete('/:id', rota(async (req, res) => {
  const _id = idOu404(req.params.id);
  const resultado = await produtos().updateOne({ _id }, { $set: { ativo: false, atualizado_em: new Date() } });
  if (resultado.matchedCount === 0) throw erros.naoEncontrado('Produto não encontrado.');
  res.status(204).end();
}));

module.exports = router;
