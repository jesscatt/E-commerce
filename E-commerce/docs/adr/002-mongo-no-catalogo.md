# ADR 002: MongoDB no catálogo, Postgres no resto

Status: aceita

## Contexto

Cada categoria de produto tem atributos diferentes (celular: memória e cor; camiseta: tamanho e tecido; livro: autor e páginas). A vitrine é muito mais lida do que escrita. Usuários, pedidos e pagamentos têm estrutura fixa e precisam de garantias do banco.

## Decisão

Catálogo no MongoDB, com os atributos livres dentro de `atributos`. Usuários, pedidos e pagamentos no Postgres (persistência poliglota).

## Consequências

- No Mongo, cada produto guarda só os campos que tem, sem colunas vazias nem tabela chave-valor.
- O Mongo não garante a estrutura: a validação fica no serviço (`catalogo/src/validacao.js`) e as regras essenciais viram índices (`sku` e `slug` únicos).
- No Postgres ficam o `UNIQUE` no e-mail, a FK de endereço e o `pedido_id UNIQUE` do pagamento, que o banco garante sozinho.
- Dois tipos de banco para a equipe conhecer.
