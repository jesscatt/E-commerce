// Seed obrigatório: 3 categorias e pelo menos 10 produtos com atributos diferentes por categoria.
// Idempotente: usa upsert pelo slug / sku com $setOnInsert, então rodar duas vezes não duplica
// e não desfaz alterações feitas depois (ex.: estoque ajustado no teste).
const { conectar, criarIndices, fechar } = require('../src/db');

const categorias = [
  { nome: 'Celulares', slug: 'celulares' },
  { nome: 'Roupas', slug: 'roupas' },
  { nome: 'Livros', slug: 'livros' },
];

const produtos = [
  // celulares: memória e cor
  { sku: 'CEL-001', nome: 'Smartphone X', categoria: 'celulares', preco: 2499.9,
    atributos: { memoria: '128GB', cor: 'preto' }, estoque: { disponivel: 10, reservado: 0 } },
  { sku: 'CEL-002', nome: 'Smartphone X Pro', categoria: 'celulares', preco: 3899.9,
    atributos: { memoria: '256GB', cor: 'azul' }, estoque: { disponivel: 5, reservado: 0 } },
  { sku: 'CEL-003', nome: 'Smartphone Lite', categoria: 'celulares', preco: 1199.0,
    atributos: { memoria: '64GB', cor: 'branco' }, estoque: { disponivel: 25, reservado: 0 } },
  { sku: 'CEL-004', nome: 'Smartphone Max', categoria: 'celulares', preco: 4599.0,
    atributos: { memoria: '512GB', cor: 'grafite' }, estoque: { disponivel: 3, reservado: 0 } },

  // roupas: tamanho e tecido
  { sku: 'CAM-010', nome: 'Camiseta básica', categoria: 'roupas', preco: 59.9,
    atributos: { tamanho: 'M', tecido: 'algodão' }, estoque: { disponivel: 40, reservado: 0 } },
  { sku: 'CAM-011', nome: 'Camiseta estampada', categoria: 'roupas', preco: 79.9,
    atributos: { tamanho: 'G', tecido: 'algodão' }, estoque: { disponivel: 30, reservado: 0 } },
  { sku: 'MOL-020', nome: 'Moletom com capuz', categoria: 'roupas', preco: 189.9,
    atributos: { tamanho: 'P', tecido: 'moletom' }, estoque: { disponivel: 15, reservado: 0 } },
  { sku: 'CAL-030', nome: 'Calça jeans', categoria: 'roupas', preco: 149.9,
    atributos: { tamanho: '42', tecido: 'jeans' }, estoque: { disponivel: 20, reservado: 0 } },

  // livros: autor e páginas
  { sku: 'LIV-100', nome: 'Java: Como Programar', categoria: 'livros', preco: 289.0,
    atributos: { autor: 'Deitel', paginas: 1152 }, estoque: { disponivel: 8, reservado: 0 } },
  { sku: 'LIV-101', nome: 'Código Limpo', categoria: 'livros', preco: 99.9,
    atributos: { autor: 'Robert C. Martin', paginas: 425 }, estoque: { disponivel: 12, reservado: 0 } },
  { sku: 'LIV-102', nome: 'Arquitetura Limpa', categoria: 'livros', preco: 109.9,
    atributos: { autor: 'Robert C. Martin', paginas: 432 }, estoque: { disponivel: 9, reservado: 0 } },
  { sku: 'LIV-103', nome: 'Microsserviços Prontos para a Produção', categoria: 'livros', preco: 89.9,
    atributos: { autor: 'Susan J. Fowler', paginas: 224 }, estoque: { disponivel: 6, reservado: 0 } },
];

async function seed() {
  const db = await conectar();
  await criarIndices();

  for (const c of categorias) {
    await db.collection('categorias').updateOne({ slug: c.slug }, { $setOnInsert: c }, { upsert: true });
  }

  for (const p of produtos) {
    await db.collection('produtos').updateOne(
      { sku: p.sku },
      { $setOnInsert: { ...p, ativo: true, criado_em: new Date() } },
      { upsert: true },
    );
  }

  const totalCat = await db.collection('categorias').countDocuments();
  const totalProd = await db.collection('produtos').countDocuments();
  console.log(`seed ok: ${totalCat} categorias, ${totalProd} produtos`);
}

seed()
  .catch((err) => {
    console.error('Falha no seed:', err.message);
    process.exitCode = 1;
  })
  .finally(fechar);
