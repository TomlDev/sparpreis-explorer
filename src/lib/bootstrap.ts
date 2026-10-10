import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/db/client";
import { ensureDefaultProfiles } from "@/lib/routeProfiles";
import { pruneCache } from "@/lib/cache/cache";
import { startMailPolling } from "@/lib/trips/mailSync";
import { startActualsPolling } from "@/lib/trips/actuals";
import { startLivePolling } from "@/lib/trips/live";

let ready = false;
let pruneStarted = false;

/** Idempotent runtime setup: apply migrations (if present) and seed the two
 *  corridor profiles. Safe to call at the top of every server entry point. */
export function ensureReady(): void {
  if (ready) return;
  const folder = path.join(process.cwd(), "drizzle");
  try {
    if (fs.existsSync(folder)) migrate(db, { migrationsFolder: folder });
  } catch (err) {
    // Migrations may already be applied; log and continue.
    // eslint-disable-next-line no-console
    console.warn("[bootstrap] migrate skipped:", (err as Error).message);
  }
  try {
    ensureDefaultProfiles();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[bootstrap] seed skipped:", (err as Error).message);
  }
  if (!pruneStarted) {
    pruneStarted = true;
    setInterval(() => {
      try {
        pruneCache();
      } catch {
        // ignore prune errors
      }
    }, 60 * 60 * 1000).unref(); // don't keep scripts/tests alive
    startMailPolling();
    startActualsPolling();
    startLivePolling();
  }
  ready = true;
}
