CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `candidate_patterns` (
	`id` text PRIMARY KEY NOT NULL,
	`edge_id` text NOT NULL,
	`number_of_searches` integer DEFAULT 0 NOT NULL,
	`number_of_successful_journeys` integer DEFAULT 0 NOT NULL,
	`lowest_observed_price` real,
	`average_price` real,
	`last_successful_date` text,
	`score` real DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`edge_id`) REFERENCES `long_distance_edges`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `candidate_patterns_edge_id_unique` ON `candidate_patterns` (`edge_id`);--> statement-breakpoint
CREATE TABLE `edge_trip_patterns` (
	`edge_id` text NOT NULL,
	`pattern_id` text NOT NULL,
	PRIMARY KEY(`edge_id`, `pattern_id`),
	FOREIGN KEY (`edge_id`) REFERENCES `long_distance_edges`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pattern_id`) REFERENCES `trip_patterns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `favorites` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`ref_key` text,
	`data` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `hub_scores` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text,
	`station_name` text NOT NULL,
	`appearances` integer DEFAULT 0 NOT NULL,
	`successful_cheap_routes` integer DEFAULT 0 NOT NULL,
	`long_distance_connections` integer DEFAULT 0 NOT NULL,
	`score` real DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hub_scores_station_name_unique` ON `hub_scores` (`station_name`);--> statement-breakpoint
CREATE TABLE `journey_legs` (
	`id` text PRIMARY KEY NOT NULL,
	`journey_id` text NOT NULL,
	`seq` integer NOT NULL,
	`product` text,
	`line_name` text,
	`train_number` text,
	`origin_id` text,
	`origin_name` text NOT NULL,
	`dest_id` text,
	`dest_name` text NOT NULL,
	`planned_dep` text,
	`planned_arr` text,
	`duration_min` integer,
	`is_long_distance` integer DEFAULT false NOT NULL,
	`is_walking` integer DEFAULT false NOT NULL,
	`stops_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`journey_id`) REFERENCES `journeys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `jl_journey_idx` ON `journey_legs` (`journey_id`);--> statement-breakpoint
CREATE INDEX `jl_train_idx` ON `journey_legs` (`train_number`);--> statement-breakpoint
CREATE TABLE `journey_queries` (
	`id` text PRIMARY KEY NOT NULL,
	`cache_key` text NOT NULL,
	`origin_id` text,
	`destination_id` text,
	`travel_date` text NOT NULL,
	`time_window` text,
	`direction` text DEFAULT 'dep' NOT NULL,
	`passengers` integer DEFAULT 1 NOT NULL,
	`bahncard` text,
	`search_mode` text NOT NULL,
	`provider` text NOT NULL,
	`result_fingerprints` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`last_run_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `journey_queries_cache_key_unique` ON `journey_queries` (`cache_key`);--> statement-breakpoint
CREATE INDEX `jq_expiry_idx` ON `journey_queries` (`expires_at`);--> statement-breakpoint
CREATE INDEX `jq_date_idx` ON `journey_queries` (`travel_date`);--> statement-breakpoint
CREATE TABLE `journeys` (
	`id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`provider` text NOT NULL,
	`origin_id` text,
	`origin_name` text NOT NULL,
	`destination_id` text,
	`destination_name` text NOT NULL,
	`travel_date` text NOT NULL,
	`planned_departure` text NOT NULL,
	`planned_arrival` text NOT NULL,
	`duration_min` integer NOT NULL,
	`transfers` integer DEFAULT 0 NOT NULL,
	`fv_minutes` integer DEFAULT 0 NOT NULL,
	`fv_stops` integer DEFAULT 0 NOT NULL,
	`fv_legs` integer DEFAULT 0 NOT NULL,
	`min_transfer_min` integer,
	`max_transfer_min` integer,
	`deviation_min` integer DEFAULT 0 NOT NULL,
	`legs_json` text NOT NULL,
	`refresh_token` text,
	`first_seen` integer NOT NULL,
	`last_seen` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `journeys_fingerprint_unique` ON `journeys` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `j_origin_idx` ON `journeys` (`origin_id`);--> statement-breakpoint
CREATE INDEX `j_dest_idx` ON `journeys` (`destination_id`);--> statement-breakpoint
CREATE INDEX `j_date_idx` ON `journeys` (`travel_date`);--> statement-breakpoint
CREATE TABLE `locations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text,
	`lat` real,
	`lng` real,
	`source` text DEFAULT 'dbvendo' NOT NULL,
	`fetched_at` integer NOT NULL,
	`last_confirmed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `loc_name_idx` ON `locations` (`name`);--> statement-breakpoint
CREATE TABLE `long_distance_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`signature` text NOT NULL,
	`from_location_id` text,
	`from_name` text NOT NULL,
	`to_location_id` text,
	`to_name` text NOT NULL,
	`product` text NOT NULL,
	`typical_duration_min` integer NOT NULL,
	`stops_between` integer DEFAULT 0 NOT NULL,
	`times_seen` integer DEFAULT 1 NOT NULL,
	`first_seen` integer NOT NULL,
	`last_seen` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `long_distance_edges_signature_unique` ON `long_distance_edges` (`signature`);--> statement-breakpoint
CREATE INDEX `lde_from_idx` ON `long_distance_edges` (`from_location_id`);--> statement-breakpoint
CREATE INDEX `lde_to_idx` ON `long_distance_edges` (`to_location_id`);--> statement-breakpoint
CREATE INDEX `lde_product_idx` ON `long_distance_edges` (`product`);--> statement-breakpoint
CREATE INDEX `lde_duration_idx` ON `long_distance_edges` (`typical_duration_min`);--> statement-breakpoint
CREATE TABLE `price_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`journey_fingerprint` text NOT NULL,
	`travel_date` text NOT NULL,
	`price` real,
	`currency` text DEFAULT 'EUR' NOT NULL,
	`coverage` text DEFAULT 'yellow' NOT NULL,
	`observed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ps_fp_idx` ON `price_snapshots` (`journey_fingerprint`);--> statement-breakpoint
CREATE INDEX `ps_observed_idx` ON `price_snapshots` (`observed_at`);--> statement-breakpoint
CREATE TABLE `profile_stations` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`location_id` text,
	`station_name` text NOT NULL,
	`query` text,
	`priority` integer DEFAULT 0 NOT NULL,
	`resolved` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `route_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `profstation_profile_idx` ON `profile_stations` (`profile_id`);--> statement-breakpoint
CREATE TABLE `provider_cache` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`provider` text NOT NULL,
	`payload` text,
	`is_error` integer DEFAULT false NOT NULL,
	`error_info` text,
	`fetched_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pc_expiry_idx` ON `provider_cache` (`expires_at`);--> statement-breakpoint
CREATE INDEX `pc_kind_idx` ON `provider_cache` (`kind`);--> statement-breakpoint
CREATE TABLE `provider_status` (
	`provider` text PRIMARY KEY NOT NULL,
	`reachable` integer DEFAULT true NOT NULL,
	`last_success_at` integer,
	`last_error_at` integer,
	`last_error` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`paused_until` integer
);
--> statement-breakpoint
CREATE TABLE `route_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `route_profiles_key_unique` ON `route_profiles` (`key`);--> statement-breakpoint
CREATE TABLE `search_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`cache_key` text,
	`mode` text NOT NULL,
	`travel_date` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`requests_used` integer DEFAULT 0 NOT NULL,
	`budget` integer DEFAULT 0 NOT NULL,
	`candidates_checked` integer DEFAULT 0 NOT NULL,
	`results_found` integer DEFAULT 0 NOT NULL,
	`best_price` real,
	`status` text DEFAULT 'running' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ticket_offers` (
	`id` text PRIMARY KEY NOT NULL,
	`journey_fingerprint` text NOT NULL,
	`price` real,
	`currency` text DEFAULT 'EUR' NOT NULL,
	`klasse` integer DEFAULT 2 NOT NULL,
	`coverage` text DEFAULT 'yellow' NOT NULL,
	`coverage_reason` text,
	`is_full_route` integer DEFAULT false NOT NULL,
	`offer_from_name` text,
	`offer_to_name` text,
	`raw` text,
	`source` text DEFAULT 'dbvendo' NOT NULL,
	`fetched_at` integer NOT NULL,
	`valid_until` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `to_fp_idx` ON `ticket_offers` (`journey_fingerprint`);--> statement-breakpoint
CREATE INDEX `to_valid_idx` ON `ticket_offers` (`valid_until`);--> statement-breakpoint
CREATE TABLE `trip_pattern_stops` (
	`id` text PRIMARY KEY NOT NULL,
	`pattern_id` text NOT NULL,
	`seq` integer NOT NULL,
	`location_id` text,
	`station_name` text NOT NULL,
	`dep_offset_min` integer,
	`arr_offset_min` integer,
	FOREIGN KEY (`pattern_id`) REFERENCES `trip_patterns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tps_pattern_idx` ON `trip_pattern_stops` (`pattern_id`);--> statement-breakpoint
CREATE TABLE `trip_patterns` (
	`id` text PRIMARY KEY NOT NULL,
	`signature` text NOT NULL,
	`product` text NOT NULL,
	`line_name` text,
	`train_number` text,
	`operator` text,
	`first_seen` integer NOT NULL,
	`last_seen` integer NOT NULL,
	`times_seen` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trip_patterns_signature_unique` ON `trip_patterns` (`signature`);--> statement-breakpoint
CREATE INDEX `trip_number_idx` ON `trip_patterns` (`train_number`);--> statement-breakpoint
CREATE INDEX `trip_product_idx` ON `trip_patterns` (`product`);