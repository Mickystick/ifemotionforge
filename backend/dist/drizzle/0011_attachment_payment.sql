--
-- Which lot a comprobante is evidence for.
--
-- Purely additive and nullable: every existing attachment keeps meaning "the
-- proof behind this receipt", which is what it meant when it was uploaded. The
-- column only lets a NEW file say something narrower — "this slip is the one
-- for lot A-14" — on a receipt that covers several. See the note on
-- `attachments` in src/db/schema.ts.
--
ALTER TABLE `attachments` ADD `payment_id` text REFERENCES payments(id);--> statement-breakpoint
CREATE INDEX `attachments_payment_idx` ON `attachments` (`payment_id`);