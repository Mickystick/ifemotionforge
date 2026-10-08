--
-- `users.last_sign_in_at`: when each account last signed in.
--
-- The Usuarios screen used to answer "when did this person last sign in" by
-- reading the newest `login` row out of `audit_events`, which meant every
-- sign-in was a permanent row in the Historial, for the sake of one date per
-- person. Logins are no longer written there; the one fact that was ever read
-- now lives on the account and is overwritten.
--
-- Additive, and nothing is deleted. The old `login` rows stay where they are
-- until somebody chooses to remove them, and this backfills from them, so no
-- account's last sign-in goes blank on the day this ships.
--
-- `audit_events.created_at` is SQLite's own "2026-09-29 20:00:54" (UTC, no
-- zone mark); `strftime` restates it as the ISO text every other timestamp on
-- `users` is written in. An account that never signed in has no row to read and
-- stays NULL.
--
ALTER TABLE `users` ADD `last_sign_in_at` text;--> statement-breakpoint
UPDATE `users` SET `last_sign_in_at` = (
	SELECT strftime('%Y-%m-%dT%H:%M:%SZ', MAX(`created_at`))
	FROM `audit_events`
	WHERE `entity_type` = 'user' AND `action` = 'login' AND `entity_id` = `users`.`id`
);
