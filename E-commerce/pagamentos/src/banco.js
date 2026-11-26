// Conversa com o banco do cartão (banco-falso), um sistema externo, protegida por:
//   1. TIMEOUT: nenhuma chamada espera mais de 2 s (AbortSignal.timeout).
//   2. RETRY: até 3 tentativas, esperando 500 ms e 1 s (+ jitter), só para timeout,
//      erro de rede e 5xx. Um 402 é o banco dizendo "não": insistir não muda a resposta.
//   3. CIRCUIT BREAKER (opossum): com muitas falhas, para de chamar o banco por 15 s;
//      depois deixa uma chamada testar (meio-aberto).
// O retry é seguro porque a cobrança leva a "referencia" (o id do pedido): o banco
// não cobra duas vezes a mesma referência.

const esperar = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

// O circuit breaker de produção: opossum (slide "NO PROJETO: OPOSSUM").
function disjuntorOpossum(acao, log) {
  const CircuitBreaker = require('opossum');
  const disjuntor = new CircuitBreaker(acao, {
    timeout: 2500,                 // o opossum também corta, um pouco acima do timeout do fetch
    errorThresholdPercentage: 50,  // abre com 50% de falha...
    volumeThreshold: 5,            // ...em pelo menos 5 chamadas
    resetTimeout: 15000,           // 15 s até o meio-aberto
    rollingCountTimeout: 30000,    // janela de 30 s para contar as falhas (o padrão é 10 s; maior facilita a demo)
  });
  disjuntor.on('open', () => log('[pagamentos] CIRCUITO ABERTO: banco falhando, chamadas suspensas por 15 s'));
  disjuntor.on('halfOpen', () => log('[pagamentos] circuito MEIO-ABERTO: testando o banco com uma chamada'));
  disjuntor.on('close', () => log('[pagamentos] circuito FECHADO: o banco voltou'));
  return disjuntor;
}

function criarBanco({
  url = process.env.BANCO_URL || 'http://banco-falso:3000',
  timeoutMs = Number(process.env.BANCO_TIMEOUT_MS) || 2000,
  tentativas = 3,
  esperaBaseMs = 500,
  criarDisjuntor = disjuntorOpossum,
  log = console.log,
} = {}) {
  // UMA chamada, com timeout. Lança erro só para o que conta como falha do banco:
  // timeout, erro de rede e 5xx. Um 4xx é uma resposta (o banco está de pé).
  async function chamar(caminho, corpo) {
    let resposta;
    try {
      resposta = await fetch(`${url}${caminho}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (erro) {
      const timeout = erro.name === 'TimeoutError' || erro.name === 'AbortError';
      throw new Error(timeout ? `sem resposta em ${timeoutMs} ms (timeout)` : `erro de rede: ${erro.cause?.code || erro.message}`);
    }
    if (resposta.status >= 500) throw new Error(`banco respondeu ${resposta.status}`);
    return { status: resposta.status, corpo: await resposta.json().catch(() => ({})) };
  }

  const disjuntor = criarDisjuntor(chamar, log);
  const espera = (tentativa) => esperaBaseMs * 2 ** (tentativa - 1) + Math.floor(Math.random() * 100); // backoff + jitter

  // Cobra com retry por cima do circuit breaker.
  // Devolve { aprovado, codigo?, motivo?, erro?, ambiguo?, tentativas }.
  //   tentativas = chamadas que chegaram a ser feitas.
  //   ambiguo = alguma tentativa estourou o timeout: o banco PODE ter cobrado (um 503 é certeza de que não cobrou).
  async function cobrar({ pedidoId, valor, cartaoFinal, correlationId = '-' }) {
    let ultimoErro = 'falha desconhecida';
    let feitas = 0;
    let ambiguo = false;
    for (let tentativa = 1; tentativa <= tentativas; tentativa += 1) {
      try {
        const { status, corpo } = await disjuntor.fire('/cobrancas', { valor, cartaoFinal: cartaoFinal || null, referencia: pedidoId });
        feitas = tentativa;
        if (status === 201 || status === 200) {
          log(`[pagamentos] pedido=${pedidoId} correlationId=${correlationId} tentativa ${tentativa}/${tentativas}: aprovado (${corpo.codigo})`);
          return { aprovado: true, codigo: corpo.codigo, tentativas: feitas };
        }
        // 402, 400, 404, 409: o banco respondeu "não". Não se tenta de novo.
        const motivo = corpo.motivo || corpo.erro || `recusado pelo banco (${status})`;
        log(`[pagamentos] pedido=${pedidoId} correlationId=${correlationId} tentativa ${tentativa}/${tentativas}: recusado (${motivo})`);
        return { aprovado: false, motivo, tentativas: feitas };
      } catch (erro) {
        if (erro.code === 'EOPENBREAKER' || /breaker is open/i.test(erro.message)) {
          // Circuito aberto: o banco nem foi chamado, e não adianta insistir.
          log(`[pagamentos] pedido=${pedidoId} correlationId=${correlationId} tentativa ${tentativa}/${tentativas}: circuito aberto, banco não chamado`);
          return { aprovado: false, erro: true, ambiguo, motivo: 'banco indisponível (circuito aberto)', tentativas: feitas };
        }
        feitas = tentativa;
        ultimoErro = erro.message;
        if (/timeout|timed out/i.test(erro.message) || erro.code === 'ETIMEDOUT') ambiguo = true;
        log(`[pagamentos] pedido=${pedidoId} correlationId=${correlationId} tentativa ${tentativa}/${tentativas} falhou: ${ultimoErro}`);
        if (tentativa < tentativas) await esperar(espera(tentativa));
      }
    }
    return { aprovado: false, erro: true, ambiguo, motivo: `banco indisponível (${ultimoErro})`, tentativas: feitas };
  }

  // Estorno: NÃO passa pelo circuit breaker (devolver dinheiro é importante demais para ser barrado),
  // mas tem timeout e retry. Pela referência é idempotente: estornar duas vezes não devolve duas vezes.
  // Devolve { estornado: true } ou { semCobranca: true } (404: o banco nunca cobrou). Lança se não conseguir.
  async function estornar({ pedidoId, codigo, correlationId = '-' }) {
    let ultimoErro;
    for (let tentativa = 1; tentativa <= tentativas; tentativa += 1) {
      try {
        const { status, corpo } = await chamar('/estornos', { codigo: codigo || null, referencia: pedidoId });
        if (status === 201 || status === 200) {
          log(`[pagamentos] pedido=${pedidoId} correlationId=${correlationId}: ESTORNO feito (${corpo.codigo || codigo})`);
          return { estornado: true, codigo: corpo.codigo || codigo };
        }
        if (status === 404) return { semCobranca: true };
        throw new Error(`banco respondeu ${status} ao estorno`);
      } catch (erro) {
        ultimoErro = erro;
        log(`[pagamentos] pedido=${pedidoId} correlationId=${correlationId} estorno tentativa ${tentativa}/${tentativas} falhou: ${erro.message}`);
        if (tentativa < tentativas) await esperar(espera(tentativa));
      }
    }
    throw ultimoErro;
  }

  function estadoCircuito() {
    if (disjuntor.opened) return 'aberto';
    if (disjuntor.halfOpen) return 'meio-aberto';
    return 'fechado';
  }

  return { cobrar, estornar, estadoCircuito, disjuntor };
}

module.exports = { criarBanco };
