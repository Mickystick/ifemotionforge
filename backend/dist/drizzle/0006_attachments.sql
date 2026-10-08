--
-- Proof-of-payment files attached to a receipt.
--
-- Purely additive: one new table, nothing existing is touched. The file BYTES
-- live on disk under the uploads directory, not in this database — see the note
-- on `attachments` in src/db/schema.ts.
--
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_id` text NOT NULL,
	`storage_key` text NOT NULL,
	`file_name` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`uploaded_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`receipt_id`) REFERENCES `receipts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `attachments_receipt_idx` ON `attachments` (`receipt_id`);