--
-- Make `customers.phone` optional.
--
-- Same reasoning as 0007_optional_identification.sql, and the same shape of
-- fix. A customer who paid a lot outright in one visit may simply never have
-- come up in a conversation that needed a phone number, and requiring one
-- here would not produce it — it would produce a made-up placeholder, or a
-- customer who never got entered at all.
--
-- SQLite cannot drop NOT NULL in place, so the table is rebuilt: new table,
-- copy the rows, drop the old one, rename the new one into its place.
--
-- The `PRAGMA foreign_keys=OFF` that drizzle-kit writes at the top of a
-- generated rebuild is NOT here, because it does nothing: the pragma is a
-- no-op inside a transaction and the migrator wraps every migration in one.
-- Without enforcement actually off, `DROP TABLE customers` fails the moment
-- one contract points at one customer — which is to say, on every real
-- database and on none of the empty ones you would test against. It is
-- turned off around the whole transaction by `runMigrations` in
-- src/db/migrations.ts, which also runs `foreign_key_check` afterwards to
-- prove nothing was orphaned.
--
-- No `NULLIF(TRIM(...), '')` backfill needed on the copy, unlike
-- identification's: `phone` has been NOT NULL since the column existed, so
-- every row already holds a real value. Blank only becomes possible for rows
-- written after this migration, and the application layer is what turns ""
-- into NULL on the way in — see `phoneOrNull` in routes/customers.ts.
--
CREATE TABLE `__new_customers` (
	`id` text PRIMARY KEY NOT NULL,
	`full_name` text NOT NULL,
	`identification` text,
	`phone` text,
	`email` text,
	`address` text,
	`customer_since` integer NOT NULL,
	`notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text
);
--> statement-breakpoint
INSERT INTO `__new_customers`("id", "full_name", "identification", "phone", "email", "address", "customer_since", "notes", "created_at", "updated_at") SELECT "id", "full_name", "identification", "phone", "email", "address", "customer_since", "notes", "created_at", "updated_at" FROM `customers`;--> statement-breakpoint
DROP TABLE `customers`;--> statement-breakpoint
ALTER TABLE `__new_customers` RENAME TO `customers`;--> statement-breakpoint
CREATE UNIQUE INDEX `customers_identification_unique` ON `customers` (`identification`);
