# ADR 004: Os serviços confiam nos cabeçalhos X-User-*

Status: aceita

## Contexto

Só o serviço de usuários emite JWT. Os outros precisam saber quem é o cliente para filtrar "os meus pedidos".

## Decisão

O Kong apaga os `X-User-*` que vêm de fora, valida o token e injeta `X-User-Id`, `X-User-Email` e `X-User-Role`. Os serviços só leem esses cabeçalhos. Nenhum serviço publica porta.

## Consequências

- Os serviços não conhecem JWT nem o segredo: menos código e um segredo em menos lugares.
- A segurança depende de nenhum serviço ficar exposto: publicar a porta de um serviço "para testar" deixaria qualquer um mandar o `X-User-Id` de outra pessoa.
- Dentro da rede do Docker não há autenticação entre serviços (zero trust e mTLS ficaram de fora).
