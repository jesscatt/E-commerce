# ADR 009: Cache da vitrine no Redis, invalidado por versão

Status: aceita

## Contexto

A vitrine (lista de produtos, produto e categorias) é lida o tempo todo e muda pouco. Cada filtro é uma resposta diferente (roupas, busca=camiseta, todos...).

## Decisão

Cache-aside no catálogo, com Redis sem persistência e TTL de 60 s. A invalidação é por versão: toda escrita de produto ou categoria, e toda mudança de estoque (reserva, venda, devolução), faz `INCR catalogo:versao`. A versão faz parte do nome das chaves, então todas as listagens ficam velhas de uma vez. O cabeçalho `X-Cache` diz HIT, MISS ou OFF. O checkout (`?ids=`) nunca usa cache: o preço e o estoque são os de agora.

## Consequências

- Um comando invalida todas as chaves; as velhas vencem sozinhas pelo TTL.
- Invalidação grossa: qualquer venda limpa a vitrine inteira, e a próxima leitura de cada filtro vai ao Mongo.
- Se o Redis estiver fora na hora da escrita, a invalidação falha e a vitrine pode mostrar o dado velho por até 60 s (o TTL limita).
- Redis fora: a vitrine continua direto no Mongo (OFF) e o catálogo fica "degradado", nunca fora do ar.
