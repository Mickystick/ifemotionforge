--
-- Make `customers.identification` optional.
--
-- Not every buyer hands over an identidad. It is confidential, it is often not
-- asked for until a contract is being drawn up, and requiring it did not
-- produce the number — it produced an invented one, or a customer who never got
-- entered at all. A person missing from the system is worse than a person
-- missing a field.
--
-- SQLite cannot drop NOT NULL in place, so the table is rebuilt: new table, copy
-- the rows, drop the old one, rename the new one into its place. Two things
-- about that are worth knowing before touching this file.
--
-- The `PRAGMA foreign_keys=OFF` that drizzle-kit writes at the top of a
-- generated rebuild is NOT here, because it does nothing: the pragma is a no-op
-- inside a transaction and the migrator wraps every migration in one. Without
-- enforcement actually off, `DROP TABLE customers` fails the moment one
-- contract points at one customer — which is to say, on every real database and
-- on none of the empty ones you would test against. It is turned off around the
-- whole transaction by `runMigrations` in src/db/migrations.ts, which also runs
-- `foreign_key_check` afterwards to prove nothing was orphaned.
--
-- And the copy is not a plain copy: `NULLIF(TRIM(...), '')` is the backfill.
-- The column has to be NULL rather than '' for absent, because SQLite counts
-- every NULL in a unique index as distinct while two empty strings collide —
-- with '' the second customer without an identidad could not be saved at all.
-- The unique index is recreated at the end and still refuses a real duplicate.
--
CREATE TABLE `__new_customers` (
	`id` text PRIMARY KEY NOT NULL,
	`full_name` text NOT NULL,
	`identification` text,
	`phone` text NOT NULL,
	`email` text,
	`address` text,
	`customer_since` integer NOT NULL,
	`notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text
);
--> statement-breakpoint
INSERT INTO `__new_customers`("id", "full_name", "identification", "phone", "email", "address", "customer_since", "notes", "created_at", "updated_at") SELECT "id", "full_name", NULLIF(TRIM("identification"), ''), "phone", "email", "address", "customer_since", "notes", "created_at", "updated_at" FROM `customers`;--> statement-breakpoint
DROP TABLE `customers`;--> statement-breakpoint
ALTER TABLE `__new_customers` RENAME TO `customers`;--> statement-breakpoint
CREATE UNIQUE INDEX `customers_identification_unique` ON `customers` (`identification`);
