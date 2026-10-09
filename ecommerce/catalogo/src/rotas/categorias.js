const express = require('express');
const { getDb } = require('../db');
const { erros, ehChaveDuplicada } = require('../erros');
const { validarCategoria } = require('../validacao');

const router = express.Router();
const rota = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const categorias = () => getDb().collection('categorias');

function formatar({ _id, ...resto }) {
  return { id: _id.toString(), ...resto };
}

// GET /categorias  (público)
router.get('/', rota(async (req, res) => {
  const lista = await categorias().find().sort({ nome: 1 }).toArray();
  res.status(200).json(lista.map(formatar));
}));

// POST /categorias  (admin) -> 201 · 400 · 409 slug já existe
router.post('/', rota(async (req, res) => {
  const detalhes = validarCategoria(req.body);
  if (detalhes.length) throw erros.dadosInvalidos(detalhes);

  const nova = { nome: req.body.nome.trim(), slug: req.body.slug.trim() };
  try {
    const { insertedId } = await categorias().insertOne(nova);
    res.status(201).json(formatar({ _id: insertedId, ...nova }));
  } catch (err) {
    if (ehChaveDuplicada(err)) throw erros.conflito('Este slug já está cadastrado.');
    throw err;
  }
}));

module.exports = router;
