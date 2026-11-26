-- Aula da saga: o cancelamento pelo cliente vira evento (pedido.cancelado).
-- Se o Kafka falhar na hora, o pedido fica marcado e o evento é republicado depois:
-- sem isso, o estoque nunca voltaria e o pagamento nunca seria estornado.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cancelamento_pendente BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS pedidos_cancelamento_pendente_idx ON pedidos (id) WHERE cancelamento_pendente;
