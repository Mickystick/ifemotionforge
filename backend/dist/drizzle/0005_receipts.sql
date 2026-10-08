--
-- Receipts, and the columns that turn `payments` into a transaction ledger.
--
-- Every statement here ADDS something. No existing column is altered, dropped
-- or rewritten, and no existing row is touched: contracts, lots, customers and
-- the payments already posted behave exactly as they did before this ran. The
-- balance queries in routes/lots.ts, routes/customers.ts and routes/contracts.ts
-- keep summing what they summed yesterday.
--
-- Payments written before this migration have a NULL `receipt_id`, which is
-- the truth — they were recorded before there was such a thing as a receipt,
-- and the Recibos screen lists them as transactions awaiting one rather than
-- inventing a document that was never issued.
--
CREATE TABLE `receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`code` text NOT NULL,
	`lookup_code` text NOT NULL,
	`customer_id` text NOT NULL,
	`issued_on` text NOT NULL,
	`issued_by` text NOT NULL,
	`idempotency_key` text,
	`note` text,
	`voided_at` text,
	`void_reason` text,
	`voided_by` text,
	`superseded_by_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`issued_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`voided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`superseded_by_id`) REFERENCES `receipts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipts_number_unique` ON `receipts` (`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `receipts_code_unique` ON `receipts` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `receipts_lookup_code_unique` ON `receipts` (`lookup_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `receipts_idempotency_key_unique` ON `receipts` (`idempotency_key`);--> statement-breakpoint
ALTER TABLE `payments` ADD `receipt_id` text REFERENCES receipts(id);--> statement-breakpoint
ALTER TABLE `payments` ADD `reference` text;--> statement-breakpoint
ALTER TABLE `payments` ADD `notes` text;--> statement-breakpoint
ALTER TABLE `payments` ADD `reversed_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `payments` ADD `reversal_reason` text;--> statement-breakpoint
CREATE INDEX `payments_contract_idx` ON `payments` (`contract_id`,`paid_on`);--> statement-breakpoint
CREATE INDEX `payments_receipt_idx` ON `payments` (`receipt_id`);