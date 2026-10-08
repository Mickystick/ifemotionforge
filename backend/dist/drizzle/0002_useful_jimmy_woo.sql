CREATE TABLE `exchange_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`rate` text NOT NULL,
	`source` text NOT NULL,
	`provider` text,
	`set_by` text,
	`captured_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`set_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `role_capabilities` (
	`role` text NOT NULL,
	`capability` text NOT NULL,
	`enabled` integer NOT NULL,
	`granted_by` text,
	`granted_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`granted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `role_capabilities_unique` ON `role_capabilities` (`role`,`capability`);