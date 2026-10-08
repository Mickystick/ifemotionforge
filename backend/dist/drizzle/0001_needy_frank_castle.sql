ALTER TABLE `projects` ADD `area_unit` text DEFAULT 'm2' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `archived_at` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `archive_reason` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `updated_at` text;--> statement-breakpoint
-- Projects that existed before this column did have never been edited, so
-- their creation time is the truthful "last changed" value.
UPDATE `projects` SET `updated_at` = `created_at` WHERE `updated_at` IS NULL;
