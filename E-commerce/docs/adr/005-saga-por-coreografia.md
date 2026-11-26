# ADR 005: Saga por coreografia

Status: aceita

## Contexto

A compra atravessa três bancos (pedidos, catálogo e pagamentos) e um sistema externo (o banco do cartão). Não existe transação que cubra todos: o 2PC exigiria todos no ar ao mesmo tempo, e Kafka, Mongo e um banco de cartão não participam dele.

## Decisão

Saga por coreografia: cada serviço confirma a sua parte na hora, publica um evento e conhece só a própria compensação (o pedido vira CANCELADO, o estoque volta, o pagamento é estornado). Não há orquestrador.

## Consequências

- Serviço novo só começa a escutar um tópico; ninguém mais muda.
- O sistema fica consistente no fim, não no instante: o pedido passa por AGUARDANDO_ESTOQUE e AGUARDANDO_PAGAMENTO.
- O fluxo fica espalhado: a tabela de eventos do README e o `correlationId` em todo log compensam isso.
- Cada mudança de status só vale a partir do estado esperado, para eventos atrasados ou repetidos não desfazerem nada.
