--
-- What was decided about money already paid, when a contract is cancelled.
--
-- Purely additive: one nullable column. Existing cancelled contracts keep NULL,
-- which is honest — the decision was not recorded at the time. New
-- cancellations carry "none" | "held" | "refunded"; see the note on
-- `closedSettlement` in src/db/schema.ts.
--
ALTER TABLE `contracts` ADD `closed_settlement` text;