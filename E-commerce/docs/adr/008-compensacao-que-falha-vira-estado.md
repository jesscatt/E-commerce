# ADR 008: Compensação que falha vira estado gravado

Status: aceita

## Contexto

Um estorno também pode falhar (o banco caiu no meio), e um evento pode não chegar ao Kafka.

## Decisão

O estorno que falha deixa o pagamento em `ESTORNO_PENDENTE`, tentado de novo a cada 30 s (o estorno pela referência é idempotente). O evento de resultado do pagamento fica gravado antes de ser publicado (`evento_publicado`), e o cancelamento do pedido também (`cancelamento_pendente`): se o Kafka falhar, são republicados.

## Consequências

- Nenhuma compensação some só numa linha de log.
- Não é um outbox completo: o `pedido.criado` do checkout ainda é publicado depois do COMMIT sem tabela de saída (ver Limitações no README).
