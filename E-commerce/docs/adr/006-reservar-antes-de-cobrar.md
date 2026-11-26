# ADR 006: Reservar o estoque antes de cobrar

Status: aceita

## Contexto

Na saga, a ordem dos passos decide o custo de desfazer.

## Decisão

O catálogo reserva o estoque antes de o pagamentos cobrar. Sem estoque, o banco do cartão nem é chamado.

## Consequências

- Desfazer uma reserva é um UPDATE no nosso banco; desfazer uma cobrança é um estorno, com taxa, demora e aparece no extrato do cliente.
- O estoque fica preso enquanto o pagamento demora (até uns 8 s com o banco instável).
