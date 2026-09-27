import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

/**
 * Single shared SQLite connection. Stored on globalThis so Next.js dev HMR and
 * multiple route modules reuse the same handle.
 */

type DB = BetterSQLite3Database<typeof schema>;

declare global {
  // eslint-disable-next-line no-var
  var __bahnDb: DB | undefined;
  // eslint-disable-next-line no-var
  var __bahnSqlite: Database.Database | undefined;
}

function resolveDbPath(): string {
  const p = process.env.DATABASE_PATH || "./data/bahn-finder.db";
  const abs = path.isAbsolute(p) ? p : path.join(/*turbopackIgnore: true*/ process.cwd(), p);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  return abs;
}

function open(): { db: DB; sqlite: Database.Database } {
  const sqlite = new Database(resolveDbPath());
  // busy_timeout first: switching a fresh DB to WAL needs a lock, and several
  // processes (e.g. `next build` workers) may open it at the same time.
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

const existing = globalThis.__bahnDb;
let dbInstance: DB;
let sqliteInstance: Database.Database;

if (existing && globalThis.__bahnSqlite) {
  dbInstance = existing;
  sqliteInstance = globalThis.__bahnSqlite;
} else {
  const opened = open();
  dbInstance = opened.db;
  sqliteInstance = opened.sqlite;
  globalThis.__bahnDb = dbInstance;
  globalThis.__bahnSqlite = sqliteInstance;
}

export const db = dbInstance;
export const sqlite = sqliteInstance;
export { schema };
