// Testa timeout, retry, recusa sem retry, estorno e circuito aberto contra o banco-falso de verdade.
// O disjuntor aqui é um substituto mínimo com a mesma interface do opossum (fire, opened, halfOpen),
// para o teste rodar sem instalar dependências. Rode com: node --test pagamentos/test/banco.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { criarBanco } = require('../src/banco');

const PORTA = 19000 + Math.floor(Math.random() * 500);
const URL_BANCO = `http://127.0.0.1:${PORTA}`;
let processo;

// Disjuntor de teste: abre depois de N falhas seguidas (o opossum conta percentual numa janela).
function disjuntorDeTeste(limite = 5) {
  return (acao) => {
    const d = { opened: false, halfOpen: false, falhas: 0 };
    d.fire = async (...args) => {
      if (d.opened) { const e = new Error('Breaker is open'); e.code = 'EOPENBREAKER'; throw e; }
      try { const r = await acao(...args); d.falhas = 0; return r; } catch (erro) {
        d.falhas += 1;
        if (d.falhas >= limite) d.opened = true;
        throw erro;
      }
    };
    return d;
  };
}

const config = (corpo) => fetch(`${URL_BANCO}/config`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo),
});
const silencio = () => {};
const novoBanco = (extra = {}) => criarBanco({
  url: URL_BANCO, esperaBaseMs: 10, timeoutMs: 1000, criarDisjuntor: disjuntorDeTeste(), log: silencio, ...extra,
});

before(async () => {
  processo = spawn(process.execPath, [path.join(__dirname, '../../banco-falso/src/server.js')], {
    env: { ...process.env, PORT: String(PORTA), LATENCIA_MS: '0' }, stdio: 'ignore',
  });
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`${URL_BANCO}/health`)).ok) return; } catch { /* ainda subindo */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('banco-falso não subiu');
});
after(() => processo.kill());

test('pix aprovado na primeira tentativa', async () => {
  await config({ falhaPercent: 0, latenciaMs: 0 });
  const r = await novoBanco().cobrar({ pedidoId: 'a-1', valor: 60 });
  assert.equal(r.aprovado, true);
  assert.match(r.codigo, /^TX-/);
  assert.equal(r.tentativas, 1);
});

test('cartão 0002: recusado (402) e NÃO tenta de novo', async () => {
  await config({ falhaPercent: 0, latenciaMs: 0 });
  const r = await novoBanco().cobrar({ pedidoId: 'a-2', valor: 60, cartaoFinal: '0002' });
  assert.equal(r.aprovado, false);
  assert.equal(r.erro, undefined);
  assert.equal(r.motivo, 'saldo insuficiente');
  assert.equal(r.tentativas, 1);
});

test('banco fora (503 sempre): 3 tentativas e ERRO "banco indisponível"', async () => {
  await config({ falhaPercent: 100, latenciaMs: 0 });
  const r = await novoBanco().cobrar({ pedidoId: 'a-3', valor: 60 });
  assert.equal(r.erro, true);
  assert.equal(r.tentativas, 3);
  assert.match(r.motivo, /banco indisponível \(banco respondeu 503\)/);
  assert.equal(r.ambiguo, false, '503 é certeza de que não cobrou: sem estorno de segurança');
});

test('timeout: desiste, mas o banco COBROU; o estorno de segurança devolve', async () => {
  await config({ falhaPercent: 0, latenciaMs: 400 });
  const banco = novoBanco({ timeoutMs: 150, tentativas: 2 });
  const r = await banco.cobrar({ pedidoId: 'a-4', valor: 60 });
  assert.equal(r.erro, true);
  assert.match(r.motivo, /timeout/);
  assert.equal(r.ambiguo, true);
  await config({ latenciaMs: 0 });
  const estorno = await banco.estornar({ pedidoId: 'a-4' });
  assert.equal(estorno.estornado, true, 'timeout não é "não aconteceu": havia cobrança para estornar');
});

test('retry é seguro: a mesma referência não é cobrada duas vezes', async () => {
  await config({ falhaPercent: 0, latenciaMs: 0 });
  const banco = novoBanco();
  const r1 = await banco.cobrar({ pedidoId: 'a-5', valor: 60 });
  const r2 = await banco.cobrar({ pedidoId: 'a-5', valor: 60 });
  assert.equal(r1.codigo, r2.codigo);
});

test('estorno sem cobrança: o banco responde 404 e tudo bem', async () => {
  await config({ falhaPercent: 0, latenciaMs: 0 });
  assert.deepEqual(await novoBanco().estornar({ pedidoId: 'nunca-cobrado' }), { semCobranca: true });
});

test('circuito aberto: a próxima cobrança falha na hora, sem chamar o banco', async () => {
  await config({ falhaPercent: 100, latenciaMs: 0 });
  const banco = novoBanco();
  await banco.cobrar({ pedidoId: 'a-6', valor: 60 }); // 3 falhas
  await banco.cobrar({ pedidoId: 'a-7', valor: 60 }); // 2 falhas -> abre
  assert.equal(banco.estadoCircuito(), 'aberto');
  const r = await banco.cobrar({ pedidoId: 'a-8', valor: 60 });
  assert.equal(r.erro, true);
  assert.equal(r.tentativas, 0);
  assert.equal(r.motivo, 'banco indisponível (circuito aberto)');
});

test('30% de falha: o retry resolve quase todas', async () => {
  await config({ falhaPercent: 30, latenciaMs: 0 });
  const banco = novoBanco({ criarDisjuntor: disjuntorDeTeste(1000) });
  let aprovados = 0;
  for (let i = 0; i < 30; i += 1) {
    if ((await banco.cobrar({ pedidoId: `b-${i}`, valor: 10 })).aprovado) aprovados += 1;
  }
  assert.ok(aprovados >= 26, `aprovados=${aprovados} de 30`);
  await config({ falhaPercent: 0 });
});
