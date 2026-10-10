import { userAgent } from "@/lib/config";
import { mapBahncard } from "./dbVendo";
import { dlog } from "@/lib/log";
import { callImpersonate, makeImpersonatingRequest } from "./impersonate";
import { mapJourney } from "./hafasMap";
import { getLimiter, normalizeError } from "./rateLimiter";
import type { NormJourney } from "./types";

/**
 * "Echte" Pro-Forma-Preise über die bahn.de-Web-API (dbweb-Profil) mit
 * PER-ABSCHNITT-Verkehrsmitteln — der mydealz-Trick: genau ein kurzer
 * Fernverkehr-Abschnitt, Rest Nahverkehr, als EIN buchbares Sparpreis-Ticket.
 *
 * Kodierung (aus dem echten bahn.de-Frontend erfasst):
 *   produktgattungen                         → Verkehrsmittel für Abschnitt 1 (Start → 1. Zwischenhalt)
 *   zwischenhalte[i].verkehrsmittelOfNextAbschnitt → Verkehrsmittel für den Abschnitt NACH Zwischenhalt i
 * Wichtig: reiche Stations-IDs (mit @X=@Y=@p=@i=) vom orte-Endpoint, und der
 * Body muss den Browser spiegeln (kein maxUmstiege/minUmstiegszeit/sitzplatzOnly).
 */

// dbweb `produktgattungen`-Codes
export const FV_PRODUCTS = ["ICE", "EC_IC", "IR"];
export const NV_PRODUCTS = [
  "REGIONAL",
  "SBAHN",
  "BUS",
  "SCHIFF",
  "UBAHN",
  "TRAM",
  "ANRUFPFLICHTIG",
];

const ORTE_ENDPOINT = "https://www.bahn.de/web/api/reiseloesung/orte";

type WebClient = {
  journeys: (
    from: string,
    to: string,
    opt?: Record<string, unknown>,
  ) => Promise<{ journeys?: unknown[] }>;
};

/** Per-call payload the formatJourneysReq wrapper reads from ctx.opt.abschnitte. */
interface AbschnittSpec {
  richFrom: string;
  richTo: string;
  firstProducts: string[]; // Abschnitt 1
  vias: { id: string; nextProducts: string[] }[]; // je Zwischenhalt: Abschnitt danach
}

let clientPromise: Promise<WebClient> | null = null;

async function getWebClient(): Promise<WebClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { createClient } = await import("db-vendo-client");
      const { profile } = await import("db-vendo-client/p/dbweb/index.js");
      (profile as { request?: unknown }).request = makeImpersonatingRequest();
      // db-vendo's dbweb only sends a global `produktgattungen`. Wrap
      // formatJourneysReq to rewrite the body into the per-Abschnitt shape
      // when ctx.opt.abschnitte is present.
      type FmtCtx = { opt?: { abschnitte?: AbschnittSpec } };
      type FmtReq = { body?: Record<string, unknown> };
      const prof = profile as unknown as {
        formatJourneysReq: (ctx: FmtCtx, ...rest: unknown[]) => FmtReq;
      };
      const orig = prof.formatJourneysReq.bind(prof);
      prof.formatJourneysReq = (ctx: FmtCtx, ...rest: unknown[]): FmtReq => {
        const req = orig(ctx, ...rest);
        const ab = ctx?.opt?.abschnitte;
        const b = req?.body;
        if (ab && b) {
          b.abfahrtsHalt = ab.richFrom;
          b.ankunftsHalt = ab.richTo;
          b.produktgattungen = ab.firstProducts;
          b.zwischenhalte = ab.vias.map((v) => ({
            id: v.id,
            verkehrsmittelOfNextAbschnitt: v.nextProducts,
          }));
          // Mirror the real browser body — these extra fields make the
          // endpoint reject per-Abschnitt requests with HTTP 422.
          b.autonomeReservierungOnly = false;
          b.nurFahrbareVerbindungen = false;
          delete b.maxUmstiege;
          delete b.minUmstiegszeit;
          delete b.sitzplatzOnly;
        }
        return req;
      };
      // No db-hafas-stations index (~200 MB heap) — see dbVendo.ts.
      return createClient(profile as never, userAgent(), { enrichStations: false }) as unknown as WebClient;
    })();
  }
  return clientPromise;
}

// Rich-id cache (name → "A=1@O=…@X=…@Y=…@L=…@p=…@i=…@").
const richCache = new Map<string, string | null>();

/** Resolve a station name to the RICH bahn.de id (needed for per-Abschnitt). */
export async function resolveRichId(name: string): Promise<string | null> {
  const key = name.trim().toLowerCase();
  if (richCache.has(key)) return richCache.get(key)!;
  const url = `${ORTE_ENDPOINT}?typ=ALL&limit=1&suchbegriff=${encodeURIComponent(name)}`;
  try {
    const r = await callImpersonate({
      method: "get",
      url,
      headers: { Accept: "application/json", "Accept-Language": "de" },
      body: null,
      impersonate: process.env.DB_IMPERSONATE_TARGET || "chrome",
    });
    const arr = JSON.parse(r.body || "[]") as Array<{ id?: string }>;
    const id = arr[0]?.id ?? null;
    richCache.set(key, id);
    return id;
  } catch {
    richCache.set(key, null);
    return null;
  }
}

/** Extract the bare EVA/IBNR from a rich id (db-vendo validates from/to args). */
function bareId(richId: string): string | null {
  return richId.match(/@L=(\d+)@/)?.[1] ?? null;
}

export interface ProformaOptions {
  fromName: string;
  toName: string;
  /** Ordered intermediate hubs (1 → 2 abschnitte, 2 → 3 abschnitte, …). */
  viaNames: string[];
  /** Which abschnitt (0-based) is Fernverkehr; all others are Nahverkehr. */
  fvAbschnitt: number;
  departure?: Date;
  /** Search "arrive by" instead of "depart at" (takes precedence over departure). */
  arrival?: Date;
  klasse?: 1 | 2;
  /** "BC25" / "BC50" / "BC100" — without it DB prices the full fare (not comparable to the other results). */
  bahncard?: string | null;
  deutschlandTicket?: boolean;
  results?: number;
}

const limiter = getLimiter("dbweb");

/**
 * Price a single pro-forma shape: the journey Start → …vias… → Ziel where
 * exactly one abschnitt is Fernverkehr and the rest Nahverkehr. Returns the
 * mapped bookable journeys (empty array on any failure).
 */
export async function searchProforma(opts: ProformaOptions): Promise<NormJourney[]> {
  const [richFrom, richTo, ...richVias] = await Promise.all([
    resolveRichId(opts.fromName),
    resolveRichId(opts.toName),
    ...opts.viaNames.map((v) => resolveRichId(v)),
  ]);
  if (!richFrom || !richTo || richVias.some((v) => !v)) return [];

  const n = opts.viaNames.length + 1; // Anzahl Abschnitte
  const products = Array.from({ length: n }, (_, i) =>
    i === opts.fvAbschnitt ? FV_PRODUCTS : NV_PRODUCTS,
  );
  const spec: AbschnittSpec = {
    richFrom,
    richTo,
    firstProducts: products[0],
    vias: richVias.map((id, i) => ({ id: id as string, nextProducts: products[i + 1] })),
  };
  const fromArg = bareId(richFrom);
  const toArg = bareId(richTo);
  if (!fromArg || !toArg) return [];

  const opt: Record<string, unknown> = {
    results: opts.results ?? 5,
    stopovers: true,
    tickets: true,
    remarks: false,
    polylines: false,
    transfers: 16,
    abschnitte: spec,
  };
  if (opts.arrival) opt.arrival = opts.arrival;
  else if (opts.departure) opt.departure = opts.departure;
  if (opts.klasse) opt.firstClass = opts.klasse === 1;
  const loyaltyCard = mapBahncard(opts.bahncard ?? null, opts.klasse ?? 2);
  if (loyaltyCard) opt.loyaltyCard = loyaltyCard;
  if (opts.deutschlandTicket) opt.deutschlandTicketDiscount = true;

  // Akamai occasionally 403s the web endpoint from the datacenter — retry.
  return limiter.schedule(async () => {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const client = await getWebClient();
        const res = await client.journeys(fromArg, toArg, opt);
        return (res.journeys || []).map(mapJourney);
      } catch (err) {
        lastErr = err;
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 403 || status === 503) {
          await new Promise((r) => setTimeout(r, 1500 + attempt * 1500));
          continue; // Akamai throttle — back off and retry
        }
        break; // 422 / other → not retryable for this shape
      }
    }
    dlog("db", "proforma failed", {
      from: opts.fromName,
      to: opts.toName,
      vias: opts.viaNames,
      err: (lastErr as Error)?.message,
    });
    throw normalizeError(lastErr);
  });
}
