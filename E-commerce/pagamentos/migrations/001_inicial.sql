-- Tabela do slide "PAGAMENTOS: A TABELA". IF NOT EXISTS torna a migração repetível.
CREATE TABLE IF NOT EXISTS pagamentos (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- UNIQUE faz dois papéis: não cobrar duas vezes o mesmo pedido
  -- e não cobrar um pedido que já foi cancelado (a linha CANCELADO ocupa o pedido_id).
  pedido_id        UUID NOT NULL UNIQUE,
  usuario_id       UUID NOT NULL,
  cliente_email    TEXT,
  valor            NUMERIC(12,2) NOT NULL CHECK (valor >= 0),
  forma            TEXT,
  cartao_final     TEXT,
  -- PENDENTE: gravado antes de chamar o banco · APROVADO / RECUSADO: o banco respondeu
  -- ERRO: o banco não respondeu (timeout, 503, circuito aberto) · CANCELADO: cancelado antes de cobrar
  -- ESTORNADO: cobrado e devolvido · ESTORNO_PENDENTE: o estorno falhou e será tentado de novo
  status           TEXT NOT NULL CHECK (status IN (
                     'PENDENTE', 'APROVADO', 'RECUSADO', 'ERRO',
                     'CANCELADO', 'ESTORNADO', 'ESTORNO_PENDENTE')),
  tentativas       INT NOT NULL DEFAULT 0,
  codigo_transacao TEXT,          -- o TX-... devolvido pelo banco
  motivo           TEXT,          -- "saldo insuficiente", "banco indisponível (timeout)"...
  correlation_id   TEXT,
  -- O cliente cancelou enquanto a cobrança estava em andamento: estornar quando ela terminar.
  cancelamento_solicitado BOOLEAN NOT NULL DEFAULT false,
  -- O evento de resultado fica gravado antes de ser publicado: se o Kafka falhar,
  -- ele é republicado depois, sem cobrar de novo.
  evento           JSONB,
  evento_publicado BOOLEAN NOT NULL DEFAULT true,
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pagamentos_usuario_idx ON pagamentos (usuario_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS pagamentos_pendencias_idx ON pagamentos (status) WHERE status = 'ESTORNO_PENDENTE';
CREATE INDEX IF NOT EXISTS pagamentos_nao_publicados_idx ON pagamentos (atualizado_em) WHERE evento_publicado = false;
