ALTER TABLE `claims` ADD `case_id` text;--> statement-breakpoint
ALTER TABLE `claims` ADD `decided_at` integer;--> statement-breakpoint
ALTER TABLE `claims` ADD `reason` text;--> statement-breakpoint
CREATE INDEX `claims_case_idx` ON `claims` (`case_id`);