# E-commerce — Gateway, Pedidos e Kafka

Backend das Partes 2 e 3 de Arquitetura de Sistemas. O cliente acessa a API pela porta
8080 do Kong; usuários, catálogo, pedidos e seus bancos ficam na rede do Compose.

```text
Cliente → Kong :8080 → usuarios → PostgreSQL de usuários
                    → catalogo → MongoDB
                    → pedidos  → PostgreSQL de pedidos
                         └─────→ catalogo (HTTP interno, timeout de 3 s)
```

O serviço de usuários emite JWT HS256 com `sub`, `email`, `perfil`, `iss` e `exp`
(2 horas). O Kong usa `perfil` para encontrar os consumers `cliente` e `admin`,
valida o token e aplica a ACL das rotas administrativas. Apaga os cabeçalhos
`X-User-*` recebidos do cliente e os preenche com a identidade autenticada.
Os serviços confiam nessa identidade porque suas portas não são publicadas.

## Executar

Requisitos: Docker com Compose v2. Para testes fora dos containers, Node.js 24 ou
superior e npm. Não há lockfiles versionados; instalações podem resolver versões
diferentes dentro das faixas declaradas nos manifests.

1. Copie `.env.example` para `.env`, se ainda não existir, e configure
   `POSTGRES_PASSWORD` e `JWT_SECRET`. O segredo JWT precisa de pelo menos 32
   caracteres, usando letras, números e hífen. Preserve valores já configurados.
2. Inicie com `docker compose up -d --build --wait --wait-timeout 180`.
3. Verifique `GET /health/usuarios`, `GET /health/catalogo` e
   `GET /health/pedidos` na porta 8080: todos devem responder 200 com banco `ok`.

Os bancos recebem migrações e seeds na inicialização. O catálogo inicial contém
3 categorias e 12 produtos. Contas de desenvolvimento:

| Perfil | E-mail | Senha de desenvolvimento |
| --- | --- | --- |
| Cliente | cliente@loja.com | cliente123 |
| Admin | admin@loja.com | admin123 |

Essas contas são seeds de desenvolvimento. `.env` é ignorado pelo Git.
O gateway também publica a Admin API (8001) e o Manager (8002) apenas no loopback.
Ao alterar `kong/kong.yml`, reinicie com `docker compose restart gateway`.
O diretório `kong` e seu YAML precisam ser legíveis pelo usuário do container.

No ambiente em nuvem preparado para este projeto, as dependências já estão
instaladas. Use o override local, que monta o código e usa Node 24 sem reconstruir
as imagens das APIs:

```sh
export COMPOSE_FILE=/workspace/E-commerce/docker-compose.yml:/workspace/ecommerce-setup/compose.cloud.yml
docker compose up -d --no-build --wait --wait-timeout 180
```

O helper externo `/workspace/ecommerce-setup/install.sh` permite atualizar essa
instalação na nuvem. O override e o helper pertencem ao ambiente, não ao checkout.
Para acompanhar os serviços, use `docker compose logs -f`. Para parar sem apagar
os dados, use `docker compose stop`.
Se recriar as APIs e o Kong ainda usar um IP antigo em cache (502 mesmo com as
APIs saudáveis), execute `docker compose restart gateway` e repita os healthchecks.

## Verificar a entrega

Os arquivos `http/usuarios.http`, `http/catalogo.http` e `http/pedidos.http`
podem ser executados pela extensão REST Client, todos pelo gateway.

Para os testes automatizados locais, instale dependências sem gerar lockfiles:

```sh
for servico in usuarios catalogo pedidos notificacoes; do
  (cd "$servico" && npm install --package-lock=false --no-audit --no-fund) || exit
done
node --test usuarios/test/*.test.js pedidos/test/*.test.js
```

São 22 testes: 7 de usuários, 10 das regras de pedidos e 5 do cliente HTTP do
catálogo. Estes últimos verificam consulta em lote, propagação de request-id,
carrinho vazio, erro HTTP, JSON inválido e timeout, sem depender dos bancos.
O grupo adicional `checkout-postgres.test.js` fica ignorado nessa execução.
Para executá-lo na nuvem, com o override acima e o banco iniciado:

```sh
docker compose exec -T -e TEST_POSTGRES=1 pedidos node --test test/checkout-postgres.test.js
```

Esses três cenários usam PostgreSQL real e um catálogo HTTP controlado para
verificar bloqueios concorrentes e rollback. Criam UUIDs exclusivos e removem
seus dados ao terminar. Fora da nuvem, o mesmo arquivo pode ser executado com
`TEST_POSTGRES=1 node --test pedidos/test/checkout-postgres.test.js`, configurando
as variáveis de conexão `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` e `PGPASSWORD`
para um banco de desenvolvimento já migrado.

Com o Compose iniciado, execute a integração real:

```sh
node --test test/gateway-pedidos.test.js
```

Para incluir a falha real do catálogo, em uma instância de desenvolvimento
exclusiva, execute:

```sh
TEST_CATALOGO_OUTAGE=1 node --test test/gateway-pedidos.test.js
```

Esse modo requer o CLI Docker e usa `COMPOSE_FILE` quando configurado. Ele para
somente o catálogo e o restaura em `finally`, aguardando o healthcheck HTTP.
Se o processo for encerrado à força, restaure com `docker compose start catalogo`.
Sem a variável, esse caso fica explicitamente marcado como ignorado.

Use bancos de desenvolvimento: a integração cria duas contas com e-mails únicos,
um produto exclusivo e pedidos de teste. Ela cancela os pedidos e desativa o produto ao
terminar; as contas e o histórico permanecem, pois a API não oferece exclusão
física desses recursos. Não altera os produtos do seed nem os carrinhos de outros
usuários. `TEST_BASE_URL` permite selecionar outra instância de teste.

O último caso esgota o limite de login para verificar o 429. Aguarde a próxima
janela de um minuto antes de fazer login ou repetir a suíte pelo mesmo IP.

| Requisito da aula | Implementação / verificação |
| --- | --- |
| Kong sem banco; API pela 8080 | `docker-compose.yml`, `kong/kong.yml` |
| Consumers e ACL por perfil | `kong/kong.yml`; integração de 401, 403 e admin |
| Identidade vem do JWT | Integração com cabeçalhos forjados e conta cliente |
| Request-id e limite de login | Integração de correlation-id e 429 |
| Carrinho e três tabelas de pedidos | `pedidos/migrations/001_inicial.sql`; integração do checkout |
| Catálogo direto, consulta em lote e timeout | `pedidos/src/catalogo.js`; testes do cliente HTTP |
| Isolamento de pedidos e histórico de preço | Integração de 404 para outro usuário e alteração de preço |
| Checkout concorrente sem duplicação | Integração de oito checkouts; testes PostgreSQL de bloqueio e adição concorrente |
| Catálogo indisponível | Integração opcional: checkout 503, carrinho e pedidos 200 |
| Roteiros pelo gateway | Arquivos em `http/` |

O checkout retorna 202 em `AGUARDANDO_ESTOQUE`. A consulta HTTP ao catálogo
continua para obter preço e produto ativo; o estoque é decidido pelo evento.
Falta de estoque deixa de retornar 409 síncrono: cria um pedido que será
`CANCELADO` pelo consumidor. Produto inexistente/inativo ainda retorna 409.

A leitura dos itens, a criação do pedido e o consumo do carrinho ocorrem na mesma
transação PostgreSQL, com `SELECT ... FOR UPDATE`. Checkouts do mesmo carrinho
aguardam o bloqueio: após o primeiro consumir os itens, os demais recebem 400 por
carrinho vazio. Uma adição concorrente ao mesmo produto aguarda e permanece no
carrinho após a compra. O catálogo continua com timeout de 3 s; se falhar, a
transação é revertida, preservando o carrinho e liberando os bloqueios.

Os checkpoints dos materiais são `aula-gateway-pedidos` e `aula-kafka`. Crie as
tags nos respectivos commits revisados; nenhuma tag foi criada automaticamente.


## Kafka e eventos (aula 08)

Kafka 3.8 roda em KRaft, com um broker, três partições por tópico e fator de
replicação 1. Não expõe porta no host. O serviço `kafka-storage` prepara o volume
antes do broker iniciar. Catálogo, pedidos e notificações aguardam seu healthcheck.
Kafka UI fica na porta 8090 e Mailpit na 8025, ambos publicados apenas no loopback.
Notificações usa SMTP interno na 1025 e não possui rota no Kong.

Fluxo: checkout → `pedido.criado` → catálogo reserva → `estoque.reservado` ou
`estoque.insuficiente` → pedidos muda para `AGUARDANDO_PAGAMENTO` ou `CANCELADO`.
Notificações envia um e-mail de recebimento e, quando houver, um de estoque
insuficiente. Pagamentos e devolução de estoque por cancelamento manual são da
próxima aula; o estado `PAGO` ainda não é produzido por este fluxo.

| Evento | Tópico | Publica | Consome | dados |
| --- | --- | --- | --- | --- |
| pedido.criado | pedidos | pedidos | catalogo, notificacoes | usuarioId, clienteEmail, valorTotal, formaPagamento, cartaoFinal, itens |
| estoque.reservado | estoque | catalogo | pedidos | usuarioId, clienteEmail, valorTotal, formaPagamento, cartaoFinal |
| estoque.insuficiente | estoque | catalogo | pedidos, notificacoes | usuarioId, clienteEmail, motivo |

Todo evento usa `{ id, tipo, pedidoId, ocorridoEm, correlationId, dados }`, com
`key = pedidoId`. Os itens usam `produtoId`, `quantidade`, `nome`, `precoUnitario`.
O correlationId é o X-Request-Id recebido do Kong e aparece nos logs. Nunca envie
senha ou número completo de cartão. Cada serviço tem seu grupo Kafka próprio:
`catalogo`, `pedidos`, `notificacoes`; tipos desconhecidos são ignorados.

A reserva usa índice único em `reservas.pedidoId`, decrementos condicionais e
marcadores atômicos por produto. Se um item falhar, compensa os itens anteriores.
Como o Mongo roda standalone, isso é compensação, não uma transação multidocumento:
o estoque intermediário pode ser observado. Marcadores permitem retomar uma
reserva ou compensação interrompida. O resultado é persistido antes da publicação;
replay republica o mesmo evento, sem repetir descontos. Os marcadores são internos
(não aparecem na API de produtos). Pedidos só aplica eventos de estoque quando
está em `AGUARDANDO_ESTOQUE`, evitando reabrir um cancelado por evento atrasado.

Notificações registra IDs enviados em SQLite no volume `notificacoes_data` para
não repetir e-mails já concluídos após replay/reinício. Este serviço usa uma
única réplica; para escala horizontal é preciso armazenamento compartilhado e
coordenação. Existe uma janela entre o SMTP aceitar o e-mail e o registro local:
uma queda nesse instante ainda pode duplicar o e-mail; o Message-ID é estável,
mas não garante deduplicação pelo SMTP.

Limitações conhecidas desta aula:

- Não há Outbox entre PostgreSQL e Kafka. Se Kafka cair após o commit, o pedido
  pode ficar em `AGUARDANDO_ESTOQUE`. A API retorna 503 com o pedido salvo e seu
  Location; consulte o pedido, não repita a compra. Ainda não existe recuperação
  automática dessa publicação pendente.
- Sem DLQ: evento inválido ou erro persistente pode bloquear uma partição até
  intervenção. Erros são propagados; não confirmamos um evento como processado
  quando a operação falha. Um crash não recuperável do consumidor reinicia o serviço.
- Um broker, sem TLS/autenticação na rede interna, é configuração de aula.
- Não há pagamento, saga, liberação por cancelamento ou limpeza de histórico
  de reservas/marcadores nesta etapa. Use produtos de teste exclusivos.

### Testes de eventos

Na nuvem, com o override e os serviços iniciados:

```sh
docker compose exec -T -e TEST_MONGO=1 catalogo node --test test/reservas.test.js
docker compose exec -T -e TEST_KAFKA=1 catalogo node --test test/fluxo-kafka.test.js
```

O primeiro grupo testa replay, compensação, disputa da última unidade, retomada
após interrupção e falha de publicação com Mongo real. O segundo executa o fluxo pelo Kong/Kafka/Mailpit,
verifica ambos os resultados, os e-mails, o correlationId e eventos repetidos ou
atrasados. Os testes usam contas/produtos exclusivos; desativam seus produtos e
cancelam pedidos ao terminar. Histórico, contas e e-mails de teste permanecem.
Os grupos são opt-in e aparecem como ignorados sem suas respectivas variáveis.
Os testes no container de catálogo funcionam também no build padrão, pois seu
Dockerfile inclui o diretório test. O teste PostgreSQL isola a transação com um
publicador substituto; a integração acima exercita Kafka real.
