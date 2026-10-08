--
-- Adendas: new terms for contracts that are already running.
--
-- Purely additive: one new table and two nullable columns on `contracts`.
-- Nothing existing is rewritten — every contract signed before this migration
-- reads NULL in both columns, which is true: none of them was written by an
-- adenda. See the note on `contractAmendments` in src/db/schema.ts for why an
-- adenda closes the old contract and writes a new one instead of editing it.
--
-- SQLite accepts `ADD COLUMN ... REFERENCES` without rebuilding the table as
-- long as the new column defaults to NULL, which both do.
--
CREATE TABLE `contract_amendments` (
	`id` text PRIMARY KEY NOT NULL,
	`effective_on` text NOT NULL,
	`reason` text NOT NULL,
	`authorized_by` text,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `contracts` ADD `replaces_contract_id` text REFERENCES contracts(id);--> statement-breakpoint
ALTER TABLE `contracts` ADD `amendment_id` text REFERENCES contract_amendments(id);--> statement-breakpoint
CREATE UNIQUE INDEX `contracts_replaces_unique` ON `contracts` (`replaces_contract_id`);