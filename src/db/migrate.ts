import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";

// Minimal .env loader so `tsx src/db/migrate.ts` picks up DATABASE_PATH without
// pulling in an extra dependency.
function loadEnv() {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadEnv();

// Import after env is loaded so the DB path resolves correctly.
const { db } = await import("./client");

const migrationsFolder = path.join(process.cwd(), "drizzle");
migrate(db, { migrationsFolder });

// eslint-disable-next-line no-console
console.log("Migrations applied from", migrationsFolder);
