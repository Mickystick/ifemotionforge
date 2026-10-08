ALTER TABLE `contracts` ADD `sale_group_id` text;--> statement-breakpoint
ALTER TABLE `contracts` ADD `sale_type` text DEFAULT 'financed' NOT NULL;--> statement-breakpoint
ALTER TABLE `contracts` ADD `down_payment_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `contracts` ADD `term_months` integer;--> statement-breakpoint
ALTER TABLE `contracts` ADD `monthly_payment_cents` integer;--> statement-breakpoint
ALTER TABLE `contracts` ADD `due_day` integer;--> statement-breakpoint
ALTER TABLE `contracts` ADD `signed_on` text;--> statement-breakpoint
ALTER TABLE `contracts` ADD `first_due_on` text;--> statement-breakpoint
ALTER TABLE `contracts` ADD `expires_on` text;--> statement-breakpoint
ALTER TABLE `contracts` ADD `closed_at` text;--> statement-breakpoint
ALTER TABLE `contracts` ADD `closed_reason` text;--> statement-breakpoint
ALTER TABLE `contracts` ADD `notes` text;--> statement-breakpoint
ALTER TABLE `contracts` ADD `updated_at` text;--> statement-breakpoint
--
-- Give every contract written before this migration a signing date.
--
-- `signed_on` is what the payment schedule counts from, so a contract without
-- one has no schedule, no due dates and therefore no payment health. The only
-- date these rows carry is `created_at` — when the row was typed in — which is
-- the best available answer and, for a database this young, the same day.
--
-- Contracts captured from here on supply their own: the API requires it, and
-- for a sale entered months after it was signed the two dates are genuinely
-- different.
--
UPDATE `contracts`
SET `signed_on` = date(`created_at`)
WHERE `signed_on` IS NULL;
