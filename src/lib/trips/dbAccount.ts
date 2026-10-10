import fs from "node:fs";
import path from "node:path";
import { dbPath } from "@/lib/delay/job";
import { getSetting, setSetting } from "@/lib/repo/settings";
import { decrypt, encrypt } from "./crypto";

/**
 * The user's DB customer account (bahn.de "Meine Reisen", online claims).
 * The password is stored encrypted only and never sent back to the browser.
 */

const USER = "dbaccount:user";
const PW = "dbaccount:password:enc";
const STATUS = "dbaccount:status";

export interface DbAccountStatus {
  lastRunAt: number | null;
  lastOk: boolean | null;
  lastMessage: string | null;
  /** Bookings in the DB account the app has no trip for. */
  unknown: { orderNumber: string; date: string | null; from: string | null; to: string | null; tariff: string | null }[];
  /** Trips that got the price of their direction from the account. */
  updated: number;
}

const EMPTY: DbAccountStatus = { lastRunAt: null, lastOk: null, lastMessage: null, unknown: [], updated: 0 };

export function getDbUser(): string {
  return getSetting<string>(USER) ?? "";
}

export function hasDbPassword(): boolean {
  return !!getSetting<string>(PW);
}

export function dbPassword(): string | null {
  const enc = getSetting<string>(PW);
  if (!enc) return null;
  try {
    return decrypt(enc);
  } catch {
    return null;
  }
}

export function getDbAccountStatus(): DbAccountStatus {
  return { ...EMPTY, ...(getSetting<DbAccountStatus>(STATUS) ?? {}) };
}

export function setDbAccountStatus(s: Partial<DbAccountStatus>): DbAccountStatus {
  const next = { ...getDbAccountStatus(), ...s };
  setSetting(STATUS, next);
  return next;
}

/** Folder of the headless browser profile (keeps the DB login session between runs). */
export function browserDir(): string {
  const dir = path.join(path.dirname(dbPath()), "db-browser");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function setDbAccount(user: string, password?: string): void {
  const u = user.trim().slice(0, 200);
  const changed = u !== getDbUser();
  setSetting(USER, u);
  if (password) setSetting(PW, encrypt(password));
  // Another account: its password and session must not be used for the new one.
  else if (changed) setSetting(PW, null);
  if (changed) forgetSession();
}

export function forgetDbAccount(): void {
  setSetting(USER, "");
  setSetting(PW, null);
  setSetting(STATUS, EMPTY);
  forgetSession();
}

function forgetSession(): void {
  fs.rmSync(path.join(path.dirname(dbPath()), "db-browser"), { recursive: true, force: true });
}
