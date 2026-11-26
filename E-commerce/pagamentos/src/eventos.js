// Pagamentos na saga (coreografia): escuta e publica eventos, sem conhecer o fluxo inteiro.
//   estoque.reservado -> cobra no banco -> publica pagamento.aprovado ou pagamento.recusado
//   pedido.cancelado  -> ainda não cobrou? grava CANCELADO (bloqueia a cobrança futura)
//                        já cobrou (APROVADO)? estorna e publica pagamento.estornado
// Tudo que precisa vem no evento (valor, forma, cartão final, e-mail): nenhuma consulta a outro serviço.
const { pool } = require('./db');
const { criarEvento, criarKafka } = require('./kafka');
const { criarBanco } = require('./banco');

const kafka = criarKafka('pagamentos');
const banco = criarBanco();

const log = (pedidoId, correlationId, texto) =>
  console.log(`[pagamentos] pedido=${pedidoId} correlationId=${correlationId || '-'} ${texto}`);

async function buscar(pedidoId) {
  const { rows } = await pool.query('SELECT * FROM pagamentos WHERE pedido_id = $1', [pedidoId]);
  return rows[0];
}

// Publica um evento que já está gravado na linha e marca como publicado.
// Se o Kafka falhar aqui, o evento continua na tabela e o reprocessador publica depois.
async function publicarRegistrado(pedidoId, evento) {
  await kafka.publicar(evento, 'pagamentos');
  await pool.query(
    "UPDATE pagamentos SET evento_publicado = true WHERE pedido_id = $1 AND evento->>'id' = $2",
    [pedidoId, evento.id]
  );
}

function dadosDoEvento(pag, extra = {}) {
  return {
    usuarioId: pag.usuario_id,
    clienteEmail: pag.cliente_email,
    valor: Number(pag.valor),
    codigoTransacao: pag.codigo_transacao || null,
    ...extra,
  };
}

// Estorna uma cobrança aprovada. Se o banco não responder, a falha NÃO some:
// vira ESTORNO_PENDENTE (estado gravado) e o reprocessador tenta de novo.
async function estornarPagamento(pag, correlationId, motivo = 'pedido cancelado pelo cliente') {
  let resultado;
  try {
    resultado = await banco.estornar({ pedidoId: pag.pedido_id, codigo: pag.codigo_transacao, correlationId });
  } catch (erro) {
    await pool.query(
      `UPDATE pagamentos SET status = 'ESTORNO_PENDENTE', motivo = $2, atualizado_em = now()
       WHERE pedido_id = $1 AND status IN ('APROVADO', 'ERRO')`,
      [pag.pedido_id, `estorno pendente: ${erro.message}`]
    );
    console.error(`[pagamentos] ALERTA pedido=${pag.pedido_id} correlationId=${correlationId}: estorno falhou, ficou ESTORNO_PENDENTE (${erro.message})`);
    return;
  }

  if (resultado.semCobranca) {
    // 404: o banco nunca cobrou esta referência. Nada a devolver.
    await pool.query(
      `UPDATE pagamentos SET status = 'ERRO', atualizado_em = now()
       WHERE pedido_id = $1 AND status = 'ESTORNO_PENDENTE'`,
      [pag.pedido_id]
    );
    log(pag.pedido_id, correlationId, 'estorno: o banco não tinha cobrança para esta referência');
    return;
  }

  const codigo = pag.codigo_transacao || resultado.codigo || null;
  const evento = criarEvento('pagamento.estornado', pag.pedido_id,
    dadosDoEvento({ ...pag, codigo_transacao: codigo }, { motivo }), correlationId);
  // Filtro de estado: só quem ainda não está ESTORNADO muda. Evento repetido não estorna nem avisa duas vezes.
  const { rows } = await pool.query(
    `UPDATE pagamentos SET status = 'ESTORNADO', codigo_transacao = $2, motivo = $3,
            evento = $4, evento_publicado = false, atualizado_em = now()
     WHERE pedido_id = $1 AND status IN ('APROVADO', 'ESTORNO_PENDENTE', 'ERRO')
     RETURNING pedido_id`,
    [pag.pedido_id, codigo, motivo, evento]
  );
  if (rows.length) {
    log(pag.pedido_id, correlationId, `COMPENSAÇÃO: pagamento ESTORNADO (${codigo || 'sem código'})`);
    await publicarRegistrado(pag.pedido_id, evento);
  }
}

// estoque.reservado -> cobrar
async function processar(evento) {
  const { pedidoId, correlationId, dados } = evento;
  const valor = Number(dados.valorTotal);

  // 1. Idempotência: o mesmo evento entregue de novo não cria outra linha nem cobra de novo.
  const inserido = await pool.query(
    `INSERT INTO pagamentos (pedido_id, usuario_id, cliente_email, valor, forma, cartao_final, status, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'PENDENTE', $7)
     ON CONFLICT (pedido_id) DO NOTHING
     RETURNING *`,
    [pedidoId, dados.usuarioId, dados.clienteEmail || null, Number.isFinite(valor) ? valor : 0,
      dados.formaPagamento || null, dados.cartaoFinal || null, correlationId]
  );

  let pag = inserido.rows[0];
  if (!pag) {
    pag = await buscar(pedidoId);
    if (pag.status === 'CANCELADO') {
      log(pedidoId, correlationId, 'pedido já cancelado: cobrança ignorada (o banco nem é chamado)');
      return;
    }
    if (pag.evento && !pag.evento_publicado) {
      log(pedidoId, correlationId, 'evento repetido: republicando o resultado gravado');
      await publicarRegistrado(pedidoId, pag.evento);
      return;
    }
    if (pag.status !== 'PENDENTE') {
      log(pedidoId, correlationId, `evento repetido: pagamento já está ${pag.status}, nada a fazer`);
      return;
    }
    // PENDENTE: o serviço caiu no meio da cobrança. Seguro tentar de novo: o banco reconhece a referência.
    log(pedidoId, correlationId, 'retomando cobrança que ficou PENDENTE');
  }

  if (!(valor > 0)) {
    await pool.query(
      `UPDATE pagamentos SET status = 'ERRO', motivo = 'valor inválido no evento', atualizado_em = now() WHERE pedido_id = $1`,
      [pedidoId]
    );
    const recusado = criarEvento('pagamento.recusado', pedidoId, dadosDoEvento(pag, { motivo: 'valor inválido no evento' }), correlationId);
    await pool.query('UPDATE pagamentos SET evento = $2, evento_publicado = false WHERE pedido_id = $1', [pedidoId, recusado]);
    await publicarRegistrado(pedidoId, recusado);
    return;
  }

  // 2. Timeout + retry + circuit breaker.
  const r = await banco.cobrar({ pedidoId, valor, cartaoFinal: dados.cartaoFinal, correlationId });
  const status = r.aprovado ? 'APROVADO' : r.erro ? 'ERRO' : 'RECUSADO';

  const { rows } = await pool.query(
    `UPDATE pagamentos SET status = $2, tentativas = tentativas + $3, codigo_transacao = $4, motivo = $5, atualizado_em = now()
     WHERE pedido_id = $1 AND status = 'PENDENTE'
     RETURNING *`,
    [pedidoId, status, r.tentativas, r.codigo || null, r.aprovado ? null : r.motivo]
  );
  pag = rows[0] || await buscar(pedidoId);
  log(pedidoId, correlationId, `pagamento ${status} após ${r.tentativas} tentativa(s)${r.motivo ? `: ${r.motivo}` : ''}`);

  // O cliente cancelou enquanto o banco cobrava (corrida do slide "cancela no meio da cobrança").
  if (pag.cancelamento_solicitado) {
    if (status === 'APROVADO') await estornarPagamento(pag, correlationId);
    else if (status === 'ERRO' && r.ambiguo) await estornarPagamento(pag, correlationId, `estorno de segurança após ${r.motivo}`);
    return; // o pedido já está CANCELADO e o estoque já voltou: nenhum aprovado/recusado a publicar
  }

  // Timeout não quer dizer "não cobrou". Desistiu sem saber? Desfaz por segurança.
  // Se não havia cobrança, o banco responde 404 e tudo bem. (Com 503 ou circuito aberto não há dúvida: não cobrou.)
  if (status === 'ERRO' && r.ambiguo) {
    await estornarPagamento(pag, correlationId, `estorno de segurança após ${r.motivo}`);
    pag = await buscar(pedidoId);
  }

  // 3. O resultado vira evento. ERRO também publica recusado: o pedido não fica parado esperando um banco que caiu.
  const resultado = status === 'APROVADO'
    ? criarEvento('pagamento.aprovado', pedidoId, dadosDoEvento(pag), correlationId)
    : criarEvento('pagamento.recusado', pedidoId, dadosDoEvento(pag, { motivo: r.motivo }), correlationId);
  await pool.query('UPDATE pagamentos SET evento = $2, evento_publicado = false WHERE pedido_id = $1', [pedidoId, resultado]);
  await publicarRegistrado(pedidoId, resultado);
}

// pedido.cancelado -> bloquear a cobrança futura ou estornar
async function aoCancelar(evento) {
  const { pedidoId, correlationId, dados } = evento;

  // Ainda não cobrei? Ocupa o pedido_id com CANCELADO: o estoque.reservado que chegar depois é ignorado.
  const inserido = await pool.query(
    `INSERT INTO pagamentos (pedido_id, usuario_id, cliente_email, valor, forma, cartao_final, status, motivo, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'CANCELADO', 'pedido cancelado antes da cobrança', $7)
     ON CONFLICT (pedido_id) DO NOTHING
     RETURNING pedido_id`,
    [pedidoId, dados.usuarioId, dados.clienteEmail || null, Number(dados.valorTotal) || 0,
      dados.formaPagamento || null, dados.cartaoFinal || null, correlationId]
  );
  if (inserido.rows.length) {
    log(pedidoId, correlationId, 'pedido cancelado antes da cobrança: pagamento CANCELADO, cobrança futura bloqueada');
    return;
  }

  // Cobrança em andamento: marca para estornar assim que ela terminar.
  const marcado = await pool.query(
    `UPDATE pagamentos SET cancelamento_solicitado = true, atualizado_em = now()
     WHERE pedido_id = $1 AND status = 'PENDENTE' RETURNING pedido_id`,
    [pedidoId]
  );
  if (marcado.rows.length) {
    log(pedidoId, correlationId, 'cancelado durante a cobrança: será estornado se o banco aprovar');
    return;
  }

  // Já existe: só estorna se foi APROVADO. RECUSADO, ERRO, CANCELADO e ESTORNADO não têm nada a devolver.
  const pag = await buscar(pedidoId);
  if (pag.status !== 'APROVADO') {
    log(pedidoId, correlationId, `cancelamento: pagamento ${pag.status}, nada a estornar`);
    return;
  }
  await estornarPagamento(pag, correlationId);
}

// De tempos em tempos: estornos que falharam e eventos que não chegaram ao Kafka.
// "Compensação que falha não pode sumir: vira um estado gravado e uma nova tentativa."
let reprocessando = false;
async function reprocessar() {
  if (reprocessando) return;
  reprocessando = true;
  try {
    const pendentes = await pool.query("SELECT * FROM pagamentos WHERE status = 'ESTORNO_PENDENTE' ORDER BY atualizado_em LIMIT 20");
    for (const pag of pendentes.rows) {
      log(pag.pedido_id, pag.correlation_id, 'reprocessando estorno pendente');
      await estornarPagamento(pag, pag.correlation_id, 'estorno reprocessado');
    }
    const naoPublicados = await pool.query(
      `SELECT pedido_id, evento FROM pagamentos
       WHERE evento_publicado = false AND evento IS NOT NULL AND atualizado_em < now() - interval '15 seconds'
       LIMIT 50`
    );
    for (const linha of naoPublicados.rows) await publicarRegistrado(linha.pedido_id, linha.evento);
  } catch (erro) {
    console.error('[pagamentos] reprocessamento falhou:', erro.message);
  } finally {
    reprocessando = false;
  }
}

let intervalo;
async function iniciar() {
  // Escuta "estoque" (e não "pedidos") para cobrar: só cobra o que já tem estoque reservado.
  // Escuta "pedidos" só para o cancelamento.
  await kafka.iniciar(['estoque', 'pedidos'], {
    'estoque.reservado': processar,
    'pedido.cancelado': aoCancelar,
  });
  intervalo = setInterval(reprocessar, 30000);
}

async function fechar() {
  clearInterval(intervalo);
  await kafka.fechar();
}

module.exports = { iniciar, fechar, estadoCircuito: banco.estadoCircuito, verificarKafka: kafka.verificar };
