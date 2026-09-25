import { userAgent } from "@/lib/config";
import { getLimiter, normalizeError } from "./rateLimiter";
import { mapDeparture, mapJourney, mapLocation, mapTrip } from "./hafasMap";
import {
  ProviderError,
  type NormDeparture,
  type NormJourney,
  type NormJourneysResult,
  type NormLocation,
  type NormTrip,
  type RailProvider,
  type SearchJourneysOptions,
} from "./types";

/**
 * HTTP provider for any db-rest v6 compatible instance (public
 * v6.db.transport.rest, a self-hosted db-rest, or a mirror). Configure the base
 * URL via DB_REST_BASE. Useful when the direct db-vendo API is IP-blocked from
 * this host, since a db-rest instance runs on non-blocked infrastructure.
 */
export class DbRestProvider implements RailProvider {
  readonly name = "dbrest";
  private limiter = getLimiter("dbrest");
  private base: string;

  constructor(base?: string) {
    this.base = (base || process.env.DB_REST_BASE || "https://v6.db.transport.rest").replace(/\/$/, "");
  }

  private async get<T>(path: string, params: Record<string, string | number | boolean | undefined>, signal?: AbortSignal): Promise<T> {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    const url = `${this.base}${path}${qs ? `?${qs}` : ""}`;
    const res = await fetch(url, {
      headers: { "User-Agent": userAgent(), Accept: "application/json" },
      signal,
    });
    if (!res.ok) {
      throw new ProviderError(`db-rest ${res.status}`, {
        status: res.status,
        isRateLimit: res.status === 429,
        isBlocked: res.status === 403 || res.status === 401,
      });
    }
    return (await res.json()) as T;
  }

  async searchLocations(query: string, opts?: { results?: number }): Promise<NormLocation[]> {
    const key = `dbrest:loc:${query}:${opts?.results ?? 8}`;
    return this.limiter.dedupe(key, async () => {
      try {
        const res = await this.get<unknown[]>("/locations", {
          query,
          results: opts?.results ?? 8,
          poi: true,
          addresses: true,
        });
        return (res || []).map(mapLocation).filter((x): x is NormLocation => !!x);
      } catch (err) {
        throw normalizeError(err);
      }
    });
  }

  async searchJourneys(from: string, to: string, opts: SearchJourneysOptions): Promise<NormJourneysResult> {
    const p = opts.products ?? {};
    const params: Record<string, string | number | boolean | undefined> = {
      from,
      to,
      results: opts.results ?? 5,
      stopovers: opts.stopovers ?? true,
      tickets: opts.tickets ?? true,
      remarks: false,
      polylines: false,
      departure: opts.departure ? opts.departure.toISOString() : undefined,
      arrival: opts.arrival ? opts.arrival.toISOString() : undefined,
      via: opts.via,
      transfers: typeof opts.transfers === "number" ? opts.transfers : undefined,
      transferTime: typeof opts.transferTime === "number" ? opts.transferTime : undefined,
      // product filters as individual booleans (db-rest convention)
      nationalExpress: p.nationalExpress,
      national: p.national,
      regionalExpress: p.regionalExpress,
      regional: p.regional,
      suburban: p.suburban,
      bus: p.bus,
      ferry: p.ferry,
      subway: p.subway,
      tram: p.tram,
      taxi: p.taxi,
    };
    return this.limiter.schedule(async () => {
      try {
        const res = await this.get<{ journeys?: unknown[]; earlierRef?: string; laterRef?: string }>(
          "/journeys",
          params,
          opts.signal,
        );
        return {
          journeys: (res.journeys || []).map(mapJourney),
          earlierRef: res.earlierRef ?? null,
          laterRef: res.laterRef ?? null,
        };
      } catch (err) {
        throw normalizeError(err);
      }
    });
  }

  async refreshJourney(refreshToken: string, opts?: { tickets?: boolean; stopovers?: boolean }): Promise<NormJourney> {
    const key = `dbrest:refresh:${refreshToken}`;
    return this.limiter.dedupe(key, async () => {
      try {
        const res = await this.get<{ journey?: unknown } & Record<string, unknown>>(
          `/journeys/${encodeURIComponent(refreshToken)}`,
          { tickets: opts?.tickets ?? true, stopovers: opts?.stopovers ?? true, remarks: false, polylines: false },
        );
        return mapJourney(res.journey ?? res);
      } catch (err) {
        throw normalizeError(err);
      }
    });
  }

  async getTrip(id: string): Promise<NormTrip> {
    const key = `dbrest:trip:${id}`;
    return this.limiter.dedupe(key, async () => {
      try {
        const res = await this.get<{ trip?: unknown } & Record<string, unknown>>(
          `/trips/${encodeURIComponent(id)}`,
          { stopovers: true, remarks: false, polyline: false },
        );
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
    const key = `dbrest:dep:${stationId}:${opts?.when?.toISOString() ?? "now"}`;
    return this.limiter.dedupe(key, async () => {
      try {
        const res = await this.get<{ departures?: unknown[] } | unknown[]>(
          `/stops/${encodeURIComponent(stationId)}/departures`,
          {
            when: opts?.when ? opts.when.toISOString() : undefined,
            duration: opts?.duration ?? 120,
            results: opts?.results ?? 30,
          },
        );
        const arr = Array.isArray(res) ? res : (res.departures ?? []);
        return arr.map(mapDeparture);
      } catch (err) {
        throw normalizeError(err);
      }
    });
  }
}
