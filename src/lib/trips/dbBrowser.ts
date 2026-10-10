import type { BrowserContext, Page } from "playwright";
import { browserDir, dbPassword, getDbUser } from "./dbAccount";

/**
 * Drives bahn.de in a headless Chromium like a person would: log in (only when
 * the stored session expired), open "Meine Reisen" and read the JSON the page
 * itself loads. One browser at a time; it is closed after every run.
 */

const START = "https://www.bahn.de/buchung/meine-reisen";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

export class DbLoginError extends Error {}

export interface DbOrderList {
  auftraege?: DbOrder[];
  hasMoreAuftraege?: boolean;
}
export interface DbOrder {
  auftragsnummer?: string;
  gesamtreisen?: { id?: string; hinfahrt?: DbDirection; rueckfahrt?: DbDirection }[];
  status?: string;
}
/** Claim positions of one direction (order detail loaded with ?gesamtreiseId). */
export interface DbClaimPositions {
  possibleAntragList?: { positionId?: string; mehrfacheinreichungPossible?: boolean }[];
  submittedAntragList?: unknown[];
}
export interface DbDirection {
  abfahrt?: string;
  ankunft?: string;
  startort?: string;
  zielort?: string;
  name?: string;
}
export interface DbOrderDetail {
  gesamtangebot?: {
    hinfahrt?: { angebote?: DbOffer[]; fahrgastrechte?: DbClaimPositions };
    rueckfahrt?: { angebote?: DbOffer[]; fahrgastrechte?: DbClaimPositions };
    verknuepftesAngebot?: { preis?: { betrag?: number } };
  };
}
export interface DbOffer {
  instanzId?: string;
  name?: string;
  isStorniert?: boolean;
  preis?: { betrag?: number };
}

declare global {
  // eslint-disable-next-line no-var
  var __dbBrowser: Promise<unknown> | undefined;
}

export interface DbSession {
  page: Page;
  /** Upcoming bookings (what "Meine Reisen" shows first). */
  orders: DbOrderList;
  getJson: <J>(path: string) => Promise<J>;
  /** Any call with the page's login (Bearer token + cookies). */
  api: (method: "GET" | "POST" | "PUT", path: string, body?: string, headers?: Record<string, string>) => Promise<{ status: number; text: string }>;
  /** Past bookings, newest first (pages of 10). */
  pastOrders: (startIndex: number) => Promise<DbOrderList>;
}

/** Run `fn` with a logged-in bahn.de page (serialized: one browser at a time). */
export async function withDbSession<T>(fn: (s: DbSession) => Promise<T>): Promise<T> {
  while (globalThis.__dbBrowser) await globalThis.__dbBrowser.catch(() => {});
  const run = session(fn);
  globalThis.__dbBrowser = run;
  try {
    return await run;
  } finally {
    if (globalThis.__dbBrowser === run) globalThis.__dbBrowser = undefined;
  }
}

async function session<T>(fn: (s: DbSession) => Promise<T>): Promise<T> {
  const user = getDbUser();
  const password = dbPassword();
  if (!user || !password) throw new DbLoginError("Benutzername oder Passwort fürs DB-Konto fehlt.");
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new DbLoginError("Browser-Steuerung (Playwright) ist auf dem Server nicht installiert.");
  }
  let ctx: BrowserContext | null = null;
  try {
    ctx = await chromium.launchPersistentContext(browserDir(), {
      headless: true,
      locale: "de-DE",
      timezoneId: "Europe/Berlin",
      viewport: { width: 1280, height: 900 },
      userAgent: UA,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    let auth: string | null = null;
    let profileId: string | null = null;
    page.on("request", (r) => {
      if (!r.url().includes("/web/api/")) return;
      auth = r.headers()["authorization"] ?? auth;
      if (r.url().includes("/auftrag/v2")) profileId = new URL(r.url()).searchParams.get("kundenprofilId") ?? profileId;
    });

    let orders = await openMeineReisen(page);
    if (!orders) {
      await login(page, user, password);
      orders = await openMeineReisen(page);
      if (!orders) throw new DbLoginError("Nach dem Login war „Meine Reisen“ nicht erreichbar.");
    }
    const api: DbSession["api"] = (method, p, body, headers = {}) =>
      page.evaluate(
        async ({ method, p, body, headers, auth }) => {
          const r = await fetch(p, {
            method,
            credentials: "include",
            headers: { Accept: "application/json", ...headers, ...(auth ? { Authorization: auth } : {}) },
            body,
          });
          return { status: r.status, text: await r.text() };
        },
        { method, p, body, headers, auth },
      );
    const getJson = async <J>(p: string): Promise<J> => {
      const res = await api("GET", p);
      if (res.status !== 200) throw new Error(`${p.split("?")[0]}: HTTP ${res.status}`);
      return JSON.parse(res.text) as J;
    };
    const pastOrders = (startIndex: number) =>
      getJson<DbOrderList>(
        `/web/api/buchung/auftrag/v2?startIndex=${startIndex}&auftraegeReturnSize=10&auftragSortOrder=DESCENDING` +
          `&letzterGeltungszeitpunktVor=${encodeURIComponent(new Date().toISOString())}` +
          (profileId ? `&kundenprofilId=${encodeURIComponent(profileId)}` : ""),
      );
    return await fn({ page, orders, getJson, api, pastOrders });
  } finally {
    await ctx?.close().catch(() => {});
  }
}

async function dismissCookies(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: /Nur erforderliche Cookies/ })
    .click({ timeout: 6000 })
    .catch(() => {});
}

/** "Meine Reisen" → the order list the page loads (null when not logged in). */
async function openMeineReisen(page: Page): Promise<DbOrderList | null> {
  const list = page
    .waitForResponse((r) => r.url().includes("/web/api/buchung/auftrag/v2") && r.request().method() === "GET", { timeout: 20_000 })
    .then(async (r) => (r.status() === 200 ? ((await r.json()) as DbOrderList) : null))
    .catch(() => null);
  await page.goto(START, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await dismissCookies(page);
  return list;
}

async function login(page: Page, user: string, password: string): Promise<void> {
  await page.getByText(/^Anmelden$/).first().click({ timeout: 15_000 });
  await page.waitForURL(/accounts\.bahn\.de/, { timeout: 30_000 });
  const name = page.locator('input[name="username"]');
  await name.waitFor({ timeout: 20_000 });
  await name.fill(user);
  await page.getByRole("button", { name: /Einloggen/ }).first().click();
  const pw = page.locator('input[type="password"]');
  const outcome = await Promise.race([
    pw.waitFor({ timeout: 25_000 }).then(() => "password"),
    page.waitForURL(/www\.bahn\.de/, { timeout: 25_000 }).then(() => "done"),
  ]).catch(() => "timeout");
  if (outcome === "timeout") throw new DbLoginError(await failure(page, "Die Passwort-Abfrage der DB erschien nicht."));
  if (outcome === "password") {
    await pw.fill(password);
    await pw.press("Enter");
    const ok = await page.waitForURL(/www\.bahn\.de/, { timeout: 40_000 }).then(
      () => true,
      () => false,
    );
    if (!ok) throw new DbLoginError(await failure(page, "Login nicht abgeschlossen."));
  }
}

/** Readable reason from the login page (wrong password, 2FA, block). */
async function failure(page: Page, fallback: string): Promise<string> {
  const text = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
  if (/ungültig|falsch|nicht korrekt|incorrect/i.test(text)) return "Benutzername oder Passwort falsch.";
  if (/Code|Bestätigung|zwei|2-Faktor|Authenticator/i.test(text) && (await page.locator('input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="code" i]').count()))
    return "Die DB fragt einen Bestätigungscode ab (Zwei-Faktor) – das kann die App nicht.";
  if (/Access Denied|Zugriff verweigert|captcha|robot/i.test(text)) return "Die DB hat den Login vom Server blockiert (Bot-Schutz).";
  return fallback;
}
