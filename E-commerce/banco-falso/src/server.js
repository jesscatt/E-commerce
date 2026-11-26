// banco-falso: simula o banco do cartão, um sistema EXTERNO que não é nosso.
// Por isso fica fora do Kong, com porta própria (9000 na sua máquina, 3000 dentro do Docker).
// Sem banco de dados e sem dependências: só o módulo http do Node.
//
// Regras da simulação:
//   POST /cobrancas { valor, cartaoFinal, referencia }
//     - cartão terminado em 0002      -> 402 { aprovado: false, motivo: "saldo insuficiente" }
//     - qualquer outro cartão, ou pix -> 201 { aprovado: true, codigo: "TX-..." }
//     - falhaPercent (0 a 100)        -> chance de responder 503 (instabilidade)
//     - latenciaMs                    -> quanto demora para responder
//   POST /estornos { codigo, referencia } -> 201 (404 se não houve cobrança)
//   GET  /config  e  POST /config { latenciaMs, falhaPercent } -> ver e mudar ao vivo
//
// Idempotente pela "referencia" (o id do pedido): a mesma cobrança repetida não cobra de novo,
// devolve o mesmo código. É isso que deixa o retry do serviço de pagamentos seguro.
const http = require('node:http');
const { randomUUID } = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const config = {
  latenciaMs: Number(process.env.LATENCIA_MS) || 300,
  falhaPercent: Number(process.env.FALHA_PERCENT) || 0,
};
const cobrancas = new Map(); // referencia -> { codigo, valor, estornada }

const esperar = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

function responder(res, status, corpo) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(corpo));
}

function lerCorpo(req) {
  return new Promise((resolver, rejeitar) => {
    let texto = '';
    req.setEncoding('utf8');
    req.on('data', (parte) => {
      texto += parte;
      if (texto.length > 16 * 1024) { rejeitar(new Error('corpo grande demais')); req.destroy(); }
    });
    req.on('end', () => {
      if (!texto) return resolver({});
      try { resolver(JSON.parse(texto)); } catch { rejeitar(new Error('JSON inválido')); }
    });
    req.on('error', rejeitar);
  });
}

async function cobrar(req, res) {
  const { valor, cartaoFinal, referencia } = await lerCorpo(req);
  if (typeof referencia !== 'string' || !referencia || !(Number(valor) > 0)) {
    return responder(res, 400, { erro: 'Informe valor (> 0) e referencia.' });
  }

  // Instabilidade simulada: demora e responde 503, sem cobrar.
  if (Math.random() * 100 < config.falhaPercent) {
    await esperar(config.latenciaMs);
    console.log(`[banco-falso] cobrança ${referencia}: FALHA simulada (503)`);
    return responder(res, 503, { erro: 'Banco temporariamente indisponível.' });
  }

  if (cartaoFinal === '0002') {
    await esperar(config.latenciaMs);
    console.log(`[banco-falso] cobrança ${referencia}: recusada (saldo insuficiente)`);
    return responder(res, 402, { aprovado: false, motivo: 'saldo insuficiente' });
  }

  // O banco registra a cobrança ANTES de responder: se quem chamou desistir por timeout,
  // o dinheiro já saiu. Timeout quer dizer "não sei o que aconteceu", e não "não cobrou".
  let cobranca = cobrancas.get(referencia);
  if (cobranca) {
    console.log(`[banco-falso] cobrança ${referencia} REPETIDA: devolvendo a mesma (${cobranca.codigo}), sem cobrar de novo`);
  } else {
    cobranca = { codigo: `TX-${randomUUID().slice(0, 8).toUpperCase()}`, valor: Number(valor), estornada: false };
    cobrancas.set(referencia, cobranca);
    console.log(`[banco-falso] cobrança ${referencia} de R$ ${cobranca.valor}: aprovada (${cobranca.codigo})`);
  }
  await esperar(config.latenciaMs);
  responder(res, 201, { aprovado: true, codigo: cobranca.codigo });
}

// Estorno pela referência (ou pelo código). Sem cobrança: 404. Já estornada: responde igual.
async function estornar(req, res) {
  const { codigo, referencia } = await lerCorpo(req);
  let cobranca = referencia ? cobrancas.get(referencia) : undefined;
  if (!cobranca && codigo) cobranca = [...cobrancas.values()].find((c) => c.codigo === codigo);
  if (!cobranca) return responder(res, 404, { erro: 'Nenhuma cobrança para esta referência.' });
  if (!cobranca.estornada) {
    cobranca.estornada = true;
    console.log(`[banco-falso] ESTORNO da cobrança ${cobranca.codigo} (referência ${referencia || '-'}, R$ ${cobranca.valor})`);
  }
  await esperar(Math.min(config.latenciaMs, 300));
  responder(res, 201, { estornado: true, codigo: cobranca.codigo });
}

async function mudarConfig(req, res) {
  const corpo = await lerCorpo(req);
  const erros = [];
  if (corpo.latenciaMs !== undefined) {
    if (!Number.isInteger(corpo.latenciaMs) || corpo.latenciaMs < 0 || corpo.latenciaMs > 60000) erros.push('latenciaMs deve ser inteiro entre 0 e 60000');
    else config.latenciaMs = corpo.latenciaMs;
  }
  if (corpo.falhaPercent !== undefined) {
    if (typeof corpo.falhaPercent !== 'number' || corpo.falhaPercent < 0 || corpo.falhaPercent > 100) erros.push('falhaPercent deve ser um número entre 0 e 100');
    else config.falhaPercent = corpo.falhaPercent;
  }
  if (erros.length) return responder(res, 400, { erro: 'Dados inválidos.', detalhes: erros });
  console.log(`[banco-falso] config: latenciaMs=${config.latenciaMs} falhaPercent=${config.falhaPercent}`);
  responder(res, 200, config);
}

const servidor = http.createServer(async (req, res) => {
  const caminho = new URL(req.url, 'http://local').pathname;
  try {
    if (req.method === 'POST' && caminho === '/cobrancas') return await cobrar(req, res);
    if (req.method === 'POST' && caminho === '/estornos') return await estornar(req, res);
    if (req.method === 'GET' && caminho === '/config') return responder(res, 200, config);
    if (req.method === 'POST' && caminho === '/config') return await mudarConfig(req, res);
    if (req.method === 'GET' && caminho === '/health') return responder(res, 200, { servico: 'banco-falso', status: 'ok', dependencias: {}, cobrancas: cobrancas.size });
    responder(res, 404, { erro: 'Rota não encontrada.' });
  } catch (erro) {
    if (!res.headersSent) responder(res, 400, { erro: erro.message });
  }
});

servidor.listen(PORT, '0.0.0.0', () => console.log(`banco-falso ouvindo na porta ${PORT}`));
process.on('SIGTERM', () => servidor.close(() => process.exit(0)));
process.on('SIGINT', () => servidor.close(() => process.exit(0)));
