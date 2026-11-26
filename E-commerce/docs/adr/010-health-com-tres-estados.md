# ADR 010: Health com três estados

Status: aceita

## Contexto

O Docker (e, depois, um orquestrador) decide pelo /health se um serviço está bem. Um health que só responde "o processo está de pé" não diz nada; um que tira o serviço do ar por qualquer dependência derruba tudo em cascata.

## Decisão

Todo serviço responde `GET /health` com `{ servico, status, dependencias }`. Banco e Kafka são essenciais: sem eles, `fora do ar` e 503. Cache fora ou circuito do banco do cartão aberto: `degradado` e 200. Nenhum health chama o health de outro serviço.

## Consequências

- `docker compose ps` mostra unhealthy só quando o serviço de fato não consegue trabalhar.
- O pedidos não fica fora do ar quando o catálogo cai: o problema aparece no 503 do checkout e no health do próprio catálogo.
- O health faz um SELECT 1, uma pergunta ao Kafka e um PING no Redis a cada 10 s: barato, mas não é zero.
