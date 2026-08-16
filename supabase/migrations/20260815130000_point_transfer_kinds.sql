-- Ledger kinds for player-to-collector point transfers.
--
-- These live in their own migration on purpose. PostgreSQL permits
-- `alter type ... add value` inside a transaction, but the new label cannot be
-- *used* by the same transaction. Keeping the labels here guarantees they are
-- committed before 20260815130500 defines the functions that emit them.
--
-- Virtual play points only. Nothing in this file touches cash, deposits or
-- payouts, all of which remain disabled for this deployment.

alter type public.play_point_kind add value if not exists 'TRANSFER_OUT';
alter type public.play_point_kind add value if not exists 'TRANSFER_IN';
alter type public.play_point_kind add value if not exists 'TRANSFER_REFUND';
