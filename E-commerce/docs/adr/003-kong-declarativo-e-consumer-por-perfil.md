# ADR 003: Kong sem banco e um consumer por perfil

Status: aceita

## Contexto

Toda requisição precisa ter o token validado e o perfil conferido. Fazer isso em cada serviço repete código e espalha a regra de acesso.

## Decisão

O Kong é a única porta da API (8080), em modo declarativo: toda a configuração está em `kong/kong.yml`, no Git. Os consumers são perfis (`cliente`, `admin`), não pessoas: o plugin `jwt` acha o consumer pelo campo `perfil` do token (`key_claim_name: perfil`) e o `acl` libera as rotas de admin.

## Consequências

- Mudar uma regra de acesso é um commit, revisável e versionado.
- O Kong não precisa de banco nem de sincronia com o cadastro de usuários.
- Mudou o perfil de alguém no banco? Só vale no próximo login: o token antigo dura até 2 h.
- Mudança no `kong.yml` exige reiniciar o gateway.
