--
-- The signed paperwork behind a contract.
--
-- Purely additive: one new table, nothing existing is touched. The file BYTES
-- live on disk under the uploads directory, not in this database — see the note
-- on `contract_documents` in src/db/schema.ts for why this is its own table
-- rather than a nullable column on `attachments`.
--
CREATE TABLE `contract_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_id` text NOT NULL,
	`storage_key` text NOT NULL,
	`file_name` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`uploaded_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `contract_documents_contract_idx` ON `contract_documents` (`contract_id`);