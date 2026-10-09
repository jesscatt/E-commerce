# E-commerce — G2 · Arquitetura de Sistemas

Projeto baseado no PDF **06 - Arq. Sis. - E-commerce Usuários e Catálogo**, do Prof. Augusto Gehrke.

## Escopo deste pacote

**Implementado:** microserviço `usuarios` (Node.js + Express + PostgreSQL), com cadastro, login (bcrypt + JWT), consulta/atualização do próprio perfil, endereços, listagem administrativa e healthcheck.

**Ainda não incluído:** microserviço `catalogo` (responsabilidade da dupla), frontend, gateway, Kafka, pedidos e pagamentos. O Docker Compose entregue aqui sobe **somente usuarios + PostgreSQL** e deve ser combinado depois com o Compose da dupla.

## Estrutura

```text
ecommerce/
├── docker-compose.yml
├── .env.example
├── usuarios/
│   ├── Dockerfile
│   ├── package.json
│   ├── migrations/001_initial.sql
│   ├── seeds/seed.js
│   ├── scripts/bootstrap.js
│   ├── src/
│   └── test/
├── http/usuarios.http
└── README.md
```

## Executar em casa (com Docker Desktop instalado)

1. Renomeie/copiei `.env.example` para `.env` na raiz do projeto. Troque `POSTGRES_PASSWORD` e `JWT_SECRET` por valores locais seguros. O `.env` está ignorado pelo Git.
2. Abra um terminal **na raiz do projeto**, onde está `docker-compose.yml`.
3. Execute:

```bash
docker compose up -d --build
docker compose ps
docker compose logs usuarios
```

4. A API estará em `http://localhost:3001`. Verifique `http://localhost:3001/health`.
5. Instale a extensão **REST Client** no VS Code, abra `http/usuarios.http` e clique em **Send Request** em cada exemplo.

O container `usuarios` executa automaticamente **migração + seed** antes de iniciar a API. Isso também funciona após reiniciar o Compose: não duplica usuários ou endereço.

### Usuários de desenvolvimento obrigatórios

| Perfil | E-mail | Senha de teste |
|---|---|---|
| admin | `admin@loja.com` | `admin123` |
| cliente | `cliente@loja.com` | `cliente123` |

O cliente inicial recebe um endereço de exemplo em Santa Maria/RS. Essas credenciais **não devem ser utilizadas em produção**. As senhas são armazenadas somente como hash bcrypt.

## Rotas exigidas no material

| Método | Rota | Acesso |
|---|---|---|
| POST | `/auth/login` | público |
| POST | `/usuarios` | público |
| GET | `/usuarios/me` | autenticado |
| PUT | `/usuarios/me` | autenticado |
| GET | `/usuarios/me/enderecos` | autenticado |
| POST | `/usuarios/me/enderecos` | autenticado |
| DELETE | `/usuarios/me/enderecos/:id` | autenticado |
| GET | `/usuarios` | admin |
| GET | `/health` | público |

Respostas de erro utilizam `{ "erro": "..." }`, com campo opcional `detalhes`. Endpoints não devolvem `senha_hash`.

**Nota:** o POST público sempre cria contas do perfil `cliente`, mesmo que o JSON tente definir `admin`.

## Testes e repetição do seed

Para executar testes unitários de validação (sem banco):

```bash
cd usuarios
npm install
npm test
```

> Como o pacote foi gerado em ambiente sem acesso ao registro npm, o arquivo `package-lock.json` ainda **não foi gerado**. Na primeira instalação com internet, `npm install` o criará: inclua-o no commit do Git para fixar as dependências. O Dockerfile usa `npm ci` automaticamente assim que existir um lockfile.

Para verificar o seed idempotente, faça duas vezes:

```bash
docker compose exec usuarios node scripts/bootstrap.js
docker compose exec usuarios node scripts/bootstrap.js
```

Em seguida, faça login com `cliente@loja.com` e consulte os endereços. Deve existir só um endereço com apelido `Casa` gerado pelo seed. **Não execute `docker compose down -v`** sem querer, pois `-v` apaga o volume do banco.

## Integração com o Catálogo da dupla

Mantenham um repositório raiz compartilhado, cada serviço na própria pasta e cada banco isolado. Quando o colega entregar `catalogo/`, acrescentem os serviços `catalogo` e seu banco ao `docker-compose.yml` da raiz, sem trocar a configuração de `usuarios` nem usar o mesmo banco. O gateway e a validação central do JWT entram **na aula seguinte**, conforme o PDF.

## Enviar ao GitHub sem testar na faculdade

Crie ou abra o repositório compartilhado no GitHub e envie os arquivos do projeto. Se a dupla já iniciou o repositório, envie a pasta `usuarios/` e `http/usuarios.http` e **façam merge do `docker-compose.yml`**, em vez de substituir o arquivo do colega.

No terminal, com Git instalado:

```bash
git init
git add .
git commit -m "Implementa microservico de usuarios do e-commerce"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/SEU-REPOSITORIO.git
git push -u origin main
```

Se o repositório já existir com commits, **clone-o primeiro e copie estes arquivos para dentro**, depois faça `git add`, `git commit` e `git push` normalmente. Não rode `git init` nem substitua `main` de um repositório compartilhado sem combinar.
