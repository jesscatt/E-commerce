# ADR 007: Banco do cartão fora do ar cancela o pedido

Status: aceita

## Contexto

Com o banco do cartão fora, o pagamentos esgota 3 tentativas (ou encontra o circuito aberto). O pedido não pode ficar parado para sempre.

## Decisão

O pagamento vira ERRO e publica `pagamento.recusado`, com o motivo `banco indisponível (...)`. A saga compensa igual a uma recusa: o pedido é cancelado e o estoque volta. Timeout é tratado como "não sei se cobrou": o pagamentos pede o estorno da referência por segurança.

## Consequências

- O cliente recebe uma resposta rápida, e o estoque não fica preso.
- Perde-se a venda: a alternativa seria pausar o consumo com o circuito aberto e cobrar quando o banco voltar, o que não perde a venda mas deixa o cliente sem resposta. É uma decisão de negócio.
