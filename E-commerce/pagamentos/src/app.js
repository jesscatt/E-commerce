const express = require('express');
const { pool } = require('./db');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rota = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// O que o cliente vê de um pagamento (sem as colunas internas da saga).
const CAMPOS = `pedido_id, status, valor::float AS valor, forma, cartao_final, tentativas,
                codigo_transacao, motivo, criado_em, atualizado_em`;

function criarApp({ estadoCircuito, verificarKafka }) {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    if (req.path === '/health') return next(); // o Docker chama a cada 10 s: fora do log
    res.on('finish', () => {
      console.log(`${req.method} ${req.originalUrl} ${res.statusCode} | x-request-id=${req.get('x-request-id') || '-'}`);
    });
    next();
  });

  // GET /health -> { servico, status, dependencias } (no gateway: GET /health/pagamentos)
  //   banco ou Kafka fora           -> "fora do ar", 503 (não consegue trabalhar)
  //   circuito do banco do cartão aberto -> "degradado", 200: o pagamentos faz o que deve, recusar rápido.
  //   Um 503 aqui tiraria o serviço do ar à toa: reiniciá-lo não traria o banco do cartão de volta.
  app.get('/health', async (req, res) => {
    const [banco, kafka] = await Promise.all([
      Promise.race([
        pool.query('SELECT 1').then(() => 'ok'),
        new Promise((resolver) => setTimeout(() => resolver('fora do ar'), 2000)),
      ]).catch(() => 'fora do ar'),
      verificarKafka(),
    ]);
    const circuitoBancoCartao = estadoCircuito().toUpperCase(); // FECHADO | ABERTO | MEIO-ABERTO
    let status = 'ok';
    if (banco !== 'ok' || kafka !== 'ok') status = 'fora do ar';
    else if (circuitoBancoCartao !== 'FECHADO') status = 'degradado';
    res.status(status === 'fora do ar' ? 503 : 200).json({
      servico: 'pagamentos', status, dependencias: { banco, kafka, circuitoBancoCartao },
    });
  });

  // Identidade injetada pelo Kong (jwt validado lá). O serviço confere dono e admin.
  function identificar(req, res, next) {
    const id = req.get('x-user-id');
    if (!UUID.test(id || '')) return res.status(401).json({ erro: 'Faça login para continuar.' });
    req.usuario = { id, perfil: req.get('x-user-role') };
    next();
  }

  // GET /pagamentos -> só admin (403 para cliente). ?status=APROVADO filtra.
  app.get('/pagamentos', identificar, rota(async (req, res) => {
    if (req.usuario.perfil !== 'admin') return res.status(403).json({ erro: 'Acesso restrito a administradores.' });
    const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : null;
    const { rows } = await pool.query(
      `SELECT ${CAMPOS}, usuario_id FROM pagamentos
       WHERE ($1::text IS NULL OR status = $1) ORDER BY criado_em DESC LIMIT 100`,
      [status]
    );
    res.status(200).json(rows);
  }));

  // GET /pagamentos/:pedidoId -> o dono do pedido ou admin. Outra pessoa: 404 (não confirma que existe).
  app.get('/pagamentos/:pedidoId', identificar, rota(async (req, res) => {
    if (!UUID.test(req.params.pedidoId)) return res.status(404).json({ erro: 'Pagamento não encontrado.' });
    const { rows } = await pool.query(
      `SELECT ${CAMPOS} FROM pagamentos WHERE pedido_id = $1 AND (usuario_id = $2 OR $3)`,
      [req.params.pedidoId, req.usuario.id, req.usuario.perfil === 'admin']
    );
    if (!rows.length) return res.status(404).json({ erro: 'Pagamento não encontrado.' });
    res.status(200).json(rows[0]);
  }));

  app.use((req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));
  app.use((erro, req, res, next) => {
    console.error(`Erro interno | x-request-id=${req.get('x-request-id') || '-'}:`, erro);
    res.status(500).json({ erro: 'Erro interno do servidor.' });
  });
  return app;
}

module.exports = { criarApp };
