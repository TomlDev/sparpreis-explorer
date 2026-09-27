CREATE TABLE `delay_builds` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`params` text NOT NULL,
	`months` text NOT NULL,
	`stations` integer DEFAULT 0 NOT NULL,
	`rows` integer DEFAULT 0 NOT NULL,
	`error` text,
	`started_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE TABLE `delay_stations` (
	`build_id` text NOT NULL,
	`eva` text NOT NULL,
	`name` text NOT NULL,
	`norm` text NOT NULL,
	`loose` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `delaystations_norm_idx` ON `delay_stations` (`build_id`,`norm`);--> statement-breakpoint
CREATE INDEX `delaystations_loose_idx` ON `delay_stations` (`build_id`,`loose`);--> statement-breakpoint
CREATE TABLE `delay_stats` (
	`build_id` text NOT NULL,
	`level` text NOT NULL,
	`key` text NOT NULL,
	`eva` text NOT NULL,
	`month` text NOT NULL,
	`dow` text NOT NULL,
	`n` integer NOT NULL,
	`cancelled` integer NOT NULL,
	`arr_hist` text NOT NULL,
	`dep_hist` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `delaystats_lookup_idx` ON `delay_stats` (`build_id`,`level`,`eva`,`key`);