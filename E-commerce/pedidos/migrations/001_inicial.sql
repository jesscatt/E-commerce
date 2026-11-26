-- Tabelas do slide "PEDIDOS: AS TABELAS". IF NOT EXISTS torna a migração repetível.

-- Sem FK para usuarios e produtos: eles moram em outros bancos (Postgres do usuarios e
-- Mongo do catalogo). Quem garante que existem é o código, perguntando ao serviço dono.
CREATE TABLE IF NOT EXISTS carrinho_itens (
  usuario_id    UUID NOT NULL,
  produto_id    TEXT NOT NULL,                 -- id do Mongo
  quantidade    INT  NOT NULL CHECK (quantidade > 0),
  adicionado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (usuario_id, produto_id)
);

CREATE TABLE IF NOT EXISTS pedidos (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id       UUID NOT NULL,
  cliente_email    TEXT NOT NULL,
  -- Já nasce com os 4 estados. Quem faz o pedido andar entre eles é o Kafka (próximas aulas).
  status           TEXT NOT NULL DEFAULT 'AGUARDANDO_ESTOQUE'
                   CHECK (status IN ('AGUARDANDO_ESTOQUE', 'AGUARDANDO_PAGAMENTO', 'PAGO', 'CANCELADO')),
  valor_total      NUMERIC(12,2) NOT NULL CHECK (valor_total >= 0),
  endereco_entrega JSONB NOT NULL,
  forma_pagamento  TEXT NOT NULL CHECK (forma_pagamento IN ('cartao', 'pix', 'boleto')),
  cartao_final     TEXT CHECK (cartao_final ~ '^[0-9]{4}$'),   -- só os 4 últimos dígitos
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pedidos_usuario_idx ON pedidos (usuario_id, criado_em DESC);

-- Preço e nome copiados: se o produto mudar de preço amanhã, o pedido de hoje não muda.
CREATE TABLE IF NOT EXISTS itens_pedido (
  pedido_id      UUID NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,  -- FK: mesmo banco
  produto_id     TEXT NOT NULL,
  nome_produto   TEXT NOT NULL,
  preco_unitario NUMERIC(12,2) NOT NULL CHECK (preco_unitario >= 0),
  quantidade     INT NOT NULL CHECK (quantidade > 0),
  PRIMARY KEY (pedido_id, produto_id)
);
