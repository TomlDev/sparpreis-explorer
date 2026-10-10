import { userAgent } from "@/lib/config";
import { getLimiter, normalizeError } from "./rateLimiter";
import { makeImpersonatingRequest } from "./impersonate";
import { mapDeparture, mapJourney, mapLocation, mapTrip } from "./hafasMap";
import {
  type NormDeparture,
  type NormJourney,
  type NormJourneysResult,
  type NormLocation,
  type NormTrip,
  type RailProvider,
  type SearchJourneysOptions,
} from "./types";

/**
 * Live Deutsche Bahn provider built on db-vendo-client. All access goes through
 * the shared rate limiter. The module is server-only (native + CJS deps).
 */

// db-vendo-client is CJS/ESM; we import lazily so it never reaches the client bundle.
type HafasClient = {
  locations: (q: string, opt?: Record<string, unknown>) => Promise<unknown[]>;
  journeys: (
    from: string,
    to: string,
    opt?: Record<string, unknown>,
  ) => Promise<{ journeys?: unknown[]; earlierRef?: string; laterRef?: string }>;
  refreshJourney: (
    token: string,
    opt?: Record<string, unknown>,
  ) => Promise<unknown>;
  trip: (id: string, opt?: Record<string, unknown>) => Promise<unknown>;
  departures: (
    station: string,
    opt?: Record<string, unknown>,
  ) => Promise<{ departures?: unknown[] } | unknown[]>;
};

let clientPromise: Promise<{ client: HafasClient; validProducts: Set<string> }> | null =
  null;

async function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { createClient } = await import("db-vendo-client");
      // dbweb = bahn.de web API (default). The DB Navigator app API (dbnav) answers
      // every request with 452 (Akamai block) since Oct 2026 — DB_VENDO_PROFILE=dbnav
      // switches back should that change.
      const useNav = (process.env.DB_VENDO_PROFILE || "").toLowerCase() === "dbnav";
      const { profile } = useNav
        ? await import("db-vendo-client/p/dbnav/index.js")
        : await import("db-vendo-client/p/dbweb/index.js");
      // Route the network call through the TLS-impersonating transport so
      // Akamai does not block us (OPS_BLOCKED / 452). Set before createClient.
      (profile as { request?: unknown }).request = makeImpersonatingRequest();
      // db-vendo-client only maps a SINGLE `opt.via`, but both APIs take a list of
      // Zwischenhalte (like DB Navigator / bahn.de, optionally with an Aufenthalt at
      // the first). Wrap formatJourneysReq to inject it.
      type Loc = { lid?: string };
      type FmtCtx = {
        opt?: { viaList?: string[]; viaStopMinutes?: number };
        profile?: { formatLocation: (p: unknown, id: string, name: string) => Loc };
      };
      type FmtReq = { body?: { reiseHin?: { wunsch?: Record<string, unknown> }; zwischenhalte?: unknown } };
      const prof = profile as unknown as {
        formatJourneysReq: (ctx: FmtCtx, ...rest: unknown[]) => FmtReq;
      };
      const origFormat = prof.formatJourneysReq.bind(prof);
      prof.formatJourneysReq = (ctx: FmtCtx, ...rest: unknown[]): FmtReq => {
        const req = origFormat(ctx, ...rest);
        const list = ctx?.opt?.viaList;
        if (!Array.isArray(list) || !list.length || !req?.body) return req;
        const stay = ctx.opt?.viaStopMinutes;
        const dwell = (i: number) => (stay && i === 0 ? { aufenthaltsdauer: stay } : {});
        if (useNav) {
          const wunsch = req.body.reiseHin?.wunsch;
          if (wunsch) wunsch.viaLocations = list.map((locationId, i) => ({ locationId, ...dwell(i) }));
        } else if (ctx.profile) {
          const p = ctx.profile;
          req.body.zwischenhalte = list.map((id, i) => ({ id: p.formatLocation(p, id, "opt.viaList").lid, ...dwell(i) }));
        }
        return req;
      };
      // enrichStations would load db-hafas-stations (340k stops, ~200 MB heap) for
      // station extras the app never reads — coordinates come with the responses.
      const client = createClient(profile as never, userAgent(), { enrichStations: false }) as unknown as HafasClient;
      const validProducts = new Set<string>(
        ((profile as { products?: Array<{ id: string }> }).products || []).map(
          (p) => p.id,
        ),
      );
      return { client, validProducts };
    })();
  }
  return clientPromise;
}

/** Map a BahnCard string (e.g. "BC25", "50", "BC100") to db-vendo-client's
 *  loyaltyCard opt. The profile compares the card type by Symbol.toString(),
 *  so a locally-constructed Symbol('Bahncard') matches. */
function mapBahncard(
  bahncard: string | null,
  klasse: 1 | 2,
): { type: symbol; discount: number; class: 1 | 2 } | undefined {
  if (!bahncard) return undefined;
  const m = String(bahncard).match(/(25|50|100)/);
  if (!m) return undefined;
  return { type: Symbol("Bahncard"), discount: Number(m[1]), class: klasse };
}

export class DbVendoProvider implements RailProvider {
  readonly name = "dbvendo";
  private limiter = getLimiter("dbvendo");

  private async buildProducts(
    filter?: SearchJourneysOptions["products"],
  ): Promise<Record<string, boolean> | undefined> {
    if (!filter) return undefined;
    const { validProducts } = await getClient();
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(filter)) {
      if (validProducts.has(k)) out[k] = !!v;
    }
    return Object.keys(out).length ? out : undefined;
  }

  async searchLocations(
    query: string,
    opts?: { results?: number },
  ): Promise<NormLocation[]> {
    const key = `loc:${query}:${opts?.results ?? 8}`;
    return this.limiter.dedupe(key, async () => {
      try {
        const { client } = await getClient();
        const res = await client.locations(query, {
          results: opts?.results ?? 8,
          fuzzy: true,
          addresses: true,
          poi: true,
        });
        return (res || []).map(mapLocation).filter((x): x is NormLocation => !!x);
      } catch (err) {
        throw normalizeError(err);
      }
    });
  }

  async searchJourneys(
    from: string,
    to: string,
    opts: SearchJourneysOptions,
  ): Promise<NormJourneysResult> {
    const products = await this.buildProducts(opts.products);
    const opt: Record<string, unknown> = {
      results: opts.results ?? 5,
      stopovers: opts.stopovers ?? true,
      tickets: opts.tickets ?? true,
      remarks: false,
      polylines: false,
    };
    if (opts.departure) opt.departure = opts.departure;
    if (opts.arrival) opt.arrival = opts.arrival;
    if (opts.viaList && opts.viaList.length) {
      opt.viaList = opts.viaList;
      if (typeof opts.viaStopMinutes === "number") opt.viaStopMinutes = opts.viaStopMinutes;
    } else if (opts.via) {
      opt.via = opts.via;
    }
    if (typeof opts.transfers === "number") opt.transfers = opts.transfers;
    if (typeof opts.transferTime === "number") opt.transferTime = opts.transferTime;
    if (products) opt.products = products;
    if (opts.klasse) opt.firstClass = opts.klasse === 1;
    if (opts.deutschlandTicket) opt.deutschlandTicketDiscount = true;
    const loyaltyCard = mapBahncard(opts.bahncard ?? null, opts.klasse ?? 2);
    if (loyaltyCard) opt.loyaltyCard = loyaltyCard;

    return this.limiter.schedule(async () => {
      try {
        let res = await client_journeys(from, to, opt);
        let journeys = (res.journeys || []).map(mapJourney);
        // The DB "Angebote" (price) sub-request is occasionally throttled and
        // returns journeys WITHOUT a price. When we asked for tickets and got
        // connections but no prices, retry once — this is the common "no prices
        // load" symptom under load.
        for (
          let attempt = 0;
          attempt < 2 &&
          opts.tickets !== false &&
          journeys.length > 0 &&
          !journeys.some((j) => j.price?.amount != null);
          attempt++
        ) {
          await new Promise((r) => setTimeout(r, 1500 + attempt * 1500));
          const res2 = await client_journeys(from, to, opt);
          const journeys2 = (res2.journeys || []).map(mapJourney);
          if (journeys2.some((j) => j.price?.amount != null)) {
            res = res2;
            journeys = journeys2;
          } else if (journeys2.length) {
            journeys = journeys2; // keep latest (still unpriced) for the next check
          }
        }
        return {
          journeys,
          earlierRef: res.earlierRef ?? null,
          laterRef: res.laterRef ?? null,
        };
      } catch (err) {
        throw normalizeError(err);
      }
    });

    async function client_journeys(f: string, t: string, o: Record<string, unknown>) {
      const { client } = await getClient();
      return client.journeys(f, t, o);
    }
  }

  async searchBestPrices(
    from: string,
    to: string,
    opts: SearchJourneysOptions,
  ): Promise<NormJourney[]> {
    const products = await this.buildProducts(opts.products);
    const opt: Record<string, unknown> = {
      results: opts.results ?? 6,
      bestprice: true,
      stopovers: false,
      tickets: true,
      remarks: false,
      polylines: false,
    };
    if (opts.departure) opt.departure = opts.departure;
    if (products) opt.products = products;
    if (opts.klasse) opt.firstClass = opts.klasse === 1;
    if (opts.deutschlandTicket) opt.deutschlandTicketDiscount = true;
    const loyaltyCard = mapBahncard(opts.bahncard ?? null, opts.klasse ?? 2);
    if (loyaltyCard) opt.loyaltyCard = loyaltyCard;
    return this.limiter.schedule(async () => {
      try {
        const { client } = await getClient();
        const res = await client.journeys(from, to, opt);
        return (res.journeys || []).map(mapJourney);
      } catch (err) {
        throw normalizeError(err);
      }
    });
  }

  async refreshJourney(
    refreshToken: string,
    opts?: { tickets?: boolean; stopovers?: boolean },
  ): Promise<NormJourney> {
    const key = `refresh:${refreshToken}`;
    return this.limiter.dedupe(key, async () => {
      try {
        const { client } = await getClient();
        const res = await client.refreshJourney(refreshToken, {
          tickets: opts?.tickets ?? true,
          stopovers: opts?.stopovers ?? true,
          remarks: false,
          polylines: false,
        });
        return mapJourney(res);
      } catch (err) {
        throw normalizeError(err);
      }
    });
  }

  async getTrip(id: string): Promise<NormTrip> {
    const key = `trip:${id}`;
    return this.limiter.dedupe(key, async () => {
      try {
        const { client } = await getClient();
        const res = await client.trip(id, { stopovers: true });
        return mapTrip(res, id);
      } catch (err) {
        throw normalizeError(err);
      }
    });
  }

  async getDepartures(
    stationId: string,
    opts?: { when?: Date; duration?: number; results?: number },
  ): Promise<NormDeparture[]> {
    const key = `dep:${stationId}:${opts?.when?.toISOString() ?? "now"}`;
    return this.limiter.dedupe(key, async () => {
      try {
        const { client } = await getClient();
        const res = await client.departures(stationId, {
          when: opts?.when,
          duration: opts?.duration ?? 120,
          results: opts?.results ?? 30,
        });
        const arr = Array.isArray(res) ? res : (res.departures ?? []);
        return arr.map(mapDeparture);
      } catch (err) {
        throw normalizeError(err);
      }
    });
  }
}
