--
-- The displayed dollar rate, and what it was derived from.
--
-- Purely additive and nullable. Every existing row keeps meaning exactly what
-- it meant when it was written: `rate` is the number that was on screen, and a
-- null `adjustment_percent` reads as "shown as the provider sent it", which is
-- what was true before this column existed.
--
-- See the notes on `exchangeRates` in src/db/schema.ts for why the provider's
-- own figure is kept beside the adjusted one.
--
ALTER TABLE `exchange_rates` ADD `provider_rate` text;--> statement-breakpoint
ALTER TABLE `exchange_rates` ADD `adjustment_percent` text;
