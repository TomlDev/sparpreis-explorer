import type { BrowserContext, Page } from "playwright";
import { browserDir, dbPassword, getDbUser } from "./dbAccount";

/**
 * Drives bahn.de in a headless Chromium like a person would: log in (only when
 * the stored session expired), open "Meine Reisen" and read the JSON the page
 * itself loads. One browser at a time; it is closed after every run — except the
 * one tab kept open while a trip is under way (Reisebegleitung).
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
  /** The bahn.de tab kept open while a trip is under way (Reisebegleitung, see fetchReiseketten). */
  // eslint-disable-next-line no-var
  var __dbWatch: { ctx: BrowserContext; page: Page } | undefined;
}

/** DB's own state of a booked journey ("Reisebegleitung" — what the DB Navigator shows). */
export interface DbReisekette {
  status?: string; // FAHRBAR | NICHT_REKONSTRUIERBAR | VORLAEUFIG_NICHT_REKONSTRUIERBAR …
  alternativensuche?: string; // ALTERNATIVEN_KANN | ALTERNATIVEN_MUSS | ALTERNATIVEN_KEINE
  relevanteAbweichung?: boolean;
  auftrag?: { auftragsnummer?: string; zugbindung?: string }; // AUFGEHOBEN | BESTEHT
  origin?: { name?: string; dateTime?: { local?: string }; rtDateTime?: { local?: string } };
  destination?: { name?: string; dateTime?: { local?: string }; rtDateTime?: { local?: string } };
}

const REISEN = "https://www.bahn.de/buchung/reiseuebersicht";

/** One serialized job on the (single) browser profile. */
async function exclusive<T>(job: () => Promise<T>): Promise<T> {
  while (globalThis.__dbBrowser) await globalThis.__dbBrowser.catch(() => {});
  const run = job();
  globalThis.__dbBrowser = run;
  try {
    return await run;
  } finally {
    if (globalThis.__dbBrowser === run) globalThis.__dbBrowser = undefined;
  }
}

/** Close the kept-open tab (no trip under way, or another job needs the profile). */
export async function closeDbWatch(): Promise<void> {
  const w = globalThis.__dbWatch;
  globalThis.__dbWatch = undefined;
  await w?.ctx.close().catch(() => {});
}

/**
 * The Reisebegleitung of all booked journeys. Keeps one bahn.de tab open between
 * calls and just reloads it — the page keeps its login fresh itself (its token
 * lives 5 min), so a new login is only needed when the tab was closed.
 */
export async function fetchReiseketten(): Promise<DbReisekette[]> {
  return exclusive(async () => {
    // The page asks more than once (first an empty list, then the journeys) — take the fullest answer.
    const load = async (page: Page) => {
      const got: DbReisekette[][] = [];
      const onResponse = async (r: import("playwright").Response) => {
        if (!r.url().includes("/web/api/reisebegleitung/reiseketten") || r.request().method() !== "GET" || r.status() !== 200) return;
        try {
          got.push(((await r.json()) as { reiseketten?: DbReisekette[] }).reiseketten ?? []);
        } catch {}
      };
      page.on("response", onResponse);
      try {
        await page.goto(REISEN, { waitUntil: "networkidle", timeout: 45_000 }).catch(() => {});
        await dismissCookies(page);
        // late requests after the page settled
        for (let i = 0; i < 10 && !got.some((l) => l.length); i++) await page.waitForTimeout(1000);
      } finally {
        page.off("response", onResponse);
      }
      return got.length ? got.reduce((a, b) => (b.length > a.length ? b : a)) : null;
    };
    let w = globalThis.__dbWatch;
    if (w) {
      const got = await load(w.page).catch(() => null);
      if (got) return got;
      await closeDbWatch(); // session gone — start over once
    }
    const opened = await openLoggedIn();
    globalThis.__dbWatch = w = { ctx: opened.ctx, page: opened.page };
    const got = await load(w.page);
    if (!got) {
      await closeDbWatch();
      throw new Error("Reisebegleitung nicht geladen");
    }
    return got;
  });
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
  return exclusive(async () => {
    await closeDbWatch(); // one browser profile — the kept-open tab makes room (reopened on its next call)
    return session(fn);
  });
}

/** A headless browser on the app's bahn.de profile, logged in, on "Meine Reisen". */
async function openLoggedIn(onRequest?: (r: import("playwright").Request) => void): Promise<{ ctx: BrowserContext; page: Page; orders: DbOrderList }> {
  const user = getDbUser();
  const password = dbPassword();
  if (!user || !password) throw new DbLoginError("Benutzername oder Passwort fürs DB-Konto fehlt.");
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new DbLoginError("Browser-Steuerung (Playwright) ist auf dem Server nicht installiert.");
  }
  const ctx = await chromium.launchPersistentContext(browserDir(), {
    headless: true,
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    viewport: { width: 1280, height: 900 },
    userAgent: UA,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    if (onRequest) page.on("request", onRequest);
    let orders = await openMeineReisen(page);
    if (!orders) {
      await login(page, user, password);
      orders = await openMeineReisen(page);
      if (!orders) throw new DbLoginError("Nach dem Login war „Meine Reisen“ nicht erreichbar.");
    }
    return { ctx, page, orders };
  } catch (e) {
    await ctx.close().catch(() => {});
    throw e;
  }
}

async function session<T>(fn: (s: DbSession) => Promise<T>): Promise<T> {
  let ctx: BrowserContext | null = null;
  try {
    let auth: string | null = null;
    let profileId: string | null = null;
    const opened = await openLoggedIn((r) => {
      if (!r.url().includes("/web/api/")) return;
      auth = r.headers()["authorization"] ?? auth;
      if (r.url().includes("/auftrag/v2")) profileId = new URL(r.url()).searchParams.get("kundenprofilId") ?? profileId;
    });
    ctx = opened.ctx;
    const { page, orders } = opened;
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
