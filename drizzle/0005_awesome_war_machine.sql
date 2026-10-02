CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text,
	`kind` text NOT NULL,
	`filename` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`path` text NOT NULL,
	`caption` text,
	`taken_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `attachments_trip_idx` ON `attachments` (`trip_id`);--> statement-breakpoint
CREATE TABLE `claims` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`delay_min` integer,
	`amount` real,
	`payout` text DEFAULT 'transfer' NOT NULL,
	`submitted_at` integer,
	`paid_at` integer,
	`paid_amount` real,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `claims_trip_idx` ON `claims` (`trip_id`);--> statement-breakpoint
CREATE TABLE `trip_events` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`type` text NOT NULL,
	`at` integer NOT NULL,
	`lat` real,
	`lng` real,
	`accuracy` real,
	`leg_index` integer,
	`text` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `trip_events_trip_idx` ON `trip_events` (`trip_id`,`at`);--> statement-breakpoint
CREATE TABLE `trips` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`origin_name` text NOT NULL,
	`dest_name` text NOT NULL,
	`planned_departure` text,
	`planned_arrival` text,
	`legs` text NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`fingerprint` text,
	`refresh_token` text,
	`order_number` text,
	`price` real,
	`klasse` integer,
	`ticket_type` text,
	`direction` text,
	`actual_arrival` text,
	`actual_legs` text,
	`aborted_at` text,
	`expected_delay_min` integer,
	`returned_to_start` integer DEFAULT false NOT NULL,
	`round_trip` integer DEFAULT false NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `trips_date_idx` ON `trips` (`date`);--> statement-breakpoint
CREATE INDEX `trips_order_idx` ON `trips` (`order_number`);