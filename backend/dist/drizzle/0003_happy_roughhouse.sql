ALTER TABLE `customers` ADD `notes` text;--> statement-breakpoint
ALTER TABLE `customers` ADD `updated_at` text;--> statement-breakpoint
--
-- Bring existing phone numbers up to the canonical E.164 shape the app now
-- stores (see src/lib/phone.ts). Every number captured before this migration
-- was written the local way, "9944-7781", which WhatsApp cannot dial.
--
-- Deliberately conservative: it only touches a row whose number, once dashes
-- and spaces are removed, is exactly the eight digits of a Honduran national
-- number. Anything else — a number already carrying a "+", a foreign number, a
-- field somebody used for two numbers or a note — is left exactly as typed,
-- for a person to correct rather than for this statement to guess at.
--
UPDATE `customers`
SET `phone` = '+504' || replace(replace(`phone`, '-', ''), ' ', '')
WHERE `phone` NOT LIKE '+%'
  AND length(replace(replace(`phone`, '-', ''), ' ', '')) = 8
  AND replace(replace(`phone`, '-', ''), ' ', '') GLOB '[0-9]*'
  AND replace(replace(`phone`, '-', ''), ' ', '') NOT GLOB '*[^0-9]*';
