--
-- Drop `receipts.superseded_by_id`.
--
-- It was a seam for a correction model this app does not use: void the receipt,
-- issue a replacement, and record the chain between the two so the customer
-- holding the old paper could be shown what replaced it. The column was read in
-- two places and written by none, for eight migrations — every row in every
-- database is NULL, so nothing is lost here.
--
-- What settled it is that Lindero corrects a receipt IN PLACE instead. An
-- amount is rewritten under a written reason (PATCH /transactions/:id) and money
-- is moved between lots with the total held fixed (POST /receipts/:id/redistribute).
-- Neither issues a second document, so nothing can ever supersede anything, and
-- a column that reads as a feature nobody can reach is worse than no column.
--
-- SQLite cannot drop a column that carries a foreign key in place, so the table
-- is rebuilt — the same twelve-step dance as 0007, and the same two warnings
-- apply:
--
-- The `PRAGMA foreign_keys=OFF` that drizzle-kit writes at the top of a
-- generated rebuild is deliberately NOT here. The pragma is a no-op inside a
-- transaction and the migrator wraps every migration in one, so leaving it in
-- reads as protection that is not there — `DROP TABLE receipts` would fail on
-- the first database that has a single payment pointing at a receipt, which is
-- every real one and none of the empty ones. `runMigrations` turns enforcement
-- off around the whole transaction and runs `foreign_key_check` afterwards.
--
-- And drizzle-kit also wanted to re-add `exchange_rates.provider_rate` and
-- `adjustment_percent` here, because 0013 was hand-written and left no snapshot
-- for it to diff against. Those columns already exist; re-adding them would fail
-- with "duplicate column name" on every database that has run 0013 and stop the
-- server on boot. They are not in this file on purpose.
--
CREATE TABLE `__new_receipts` (
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
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`issued_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`voided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_receipts`("id", "number", "code", "lookup_code", "customer_id", "issued_on", "issued_by", "idempotency_key", "note", "voided_at", "void_reason", "voided_by", "created_at") SELECT "id", "number", "code", "lookup_code", "customer_id", "issued_on", "issued_by", "idempotency_key", "note", "voided_at", "void_reason", "voided_by", "created_at" FROM `receipts`;--> statement-breakpoint
DROP TABLE `receipts`;--> statement-breakpoint
ALTER TABLE `__new_receipts` RENAME TO `receipts`;--> statement-breakpoint
CREATE UNIQUE INDEX `receipts_number_unique` ON `receipts` (`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `receipts_code_unique` ON `receipts` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `receipts_lookup_code_unique` ON `receipts` (`lookup_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `receipts_idempotency_key_unique` ON `receipts` (`idempotency_key`);
