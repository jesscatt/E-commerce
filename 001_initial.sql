-- Tabelas da página 7 do PDF; IF NOT EXISTS torna a migração repetível.
CREATE TABLE IF NOT EXISTS usuarios (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome        TEXT NOT NULL,
  email       TEXT NOT NULL UNIQUE,
  senha_hash  TEXT NOT NULL,
  perfil      TEXT NOT NULL DEFAULT 'cliente' CHECK (perfil IN ('cliente', 'admin')),
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS enderecos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id  UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  apelido     TEXT,
  cep         TEXT NOT NULL,
  logradouro  TEXT NOT NULL,
  numero      TEXT,
  complemento TEXT,
  cidade      TEXT NOT NULL,
  uf          CHAR(2) NOT NULL,
  principal   BOOLEAN NOT NULL DEFAULT false
);
