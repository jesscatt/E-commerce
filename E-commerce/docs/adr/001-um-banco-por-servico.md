# ADR 001: Um banco por serviço

Status: aceita

## Contexto

Cinco serviços precisam guardar dados. Se dois dividem o mesmo banco, uma mudança de tabela em um quebra o outro, e eles deixam de poder ser publicados separadamente (o problema 5 do monolito).

## Decisão

Cada serviço tem o seu banco, e nenhum serviço lê o banco do outro: usuarios (Postgres), catalogo (Mongo), pedidos (Postgres), pagamentos (Postgres). Quem precisa de um dado de outro serviço pergunta pela API (o pedidos pergunta o preço ao catálogo) ou recebe por evento.

## Consequências

- Cada serviço evolui o próprio schema sem combinar com os outros.
- Perde-se a transação única e o JOIN entre domínios: a compra atravessa três bancos e precisa de uma saga (ADR 005).
- Não há FOREIGN KEY entre bancos: o pedidos guarda `produto_id` como texto, e quem garante que o produto existe é a chamada ao catálogo.
- Quatro bancos para subir, monitorar e fazer backup.
