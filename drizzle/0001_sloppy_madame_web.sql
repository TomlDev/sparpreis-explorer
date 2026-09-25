CREATE TABLE `price_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`search_run_id` text,
	`travel_date` text,
	`via_name` text NOT NULL,
	`segment_signature` text NOT NULL,
	`from_name` text,
	`to_name` text,
	`product` text,
	`fv_minutes` integer DEFAULT 0 NOT NULL,
	`fv_stops` integer DEFAULT 0 NOT NULL,
	`reason` text NOT NULL,
	`exploit_rank` integer,
	`epsilon` real,
	`observed_price` real,
	`coverage` text,
	`currency` text DEFAULT 'EUR' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pd_segment_idx` ON `price_decisions` (`segment_signature`);--> statement-breakpoint
CREATE INDEX `pd_created_idx` ON `price_decisions` (`created_at`);