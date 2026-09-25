import { getLimiter, normalizeError } from "./rateLimiter";
import { mapJourney, mapLocation, mapTrip } from "./hafasMap";
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
 * Talks to a small self-hosted "DB gateway" running db-vendo-client on a
 * residential connection (see apps/db-gateway). The gateway returns raw FPTF
 * payloads which we map with the shared hafas mapper. Auth via bearer token.
 *
 * This is how the main server reaches DB prices/tickets without its own IP
 * being blocked by the DB API.
 */
export class DbGatewayProvider implements RailProvider {
  readonly name = "dbgateway";
  private base: string;
  private token: string;
  private limiter = getLimiter("dbgateway");

  constructor(base?: string, token?: string) {
    this.base = (base || process.env.DB_VENDO_GATEWAY_URL || "").replace(/\/$/, "");
    this.token = token || process.env.DB_VENDO_GATEWAY_TOKEN || "";
  }

  static isConfigured(): boolean {
    return !!(process.env.DB_VENDO_GATEWAY_URL && process.env.DB_VENDO_GATEWAY_TOKEN);
  }

  private async call<T>(path: string, init: RequestInit): Promise<T> {
    if (!this.base) throw new ProviderError("gateway not configured", { status: 503 });
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init.headers || {}),
      },
    });
    if (!res.ok) {
      throw new ProviderError(`gateway ${res.status}`, {
        status: res.status,
        isRateLimit: res.status === 429,
        isBlocked: res.status === 401 || res.status === 403,
      });
    }
    return (await res.json()) as T;
  }

  async searchLocations(query: string, opts?: { results?: number }): Promise<NormLocation[]> {
    const key = `gw:loc:${query}:${opts?.results ?? 8}`;
    return this.limiter.dedupe(key, async () => {
      try {
        const res = await this.call<{ locations?: unknown[] }>(
          `/api/locations?query=${encodeURIComponent(query)}&results=${opts?.results ?? 8}`,
          { method: "GET" },
        );
        return (res.locations || []).map(mapLocation).filter((x): x is NormLocation => !!x);
      } catch (err) {
        throw normalizeError(err);
      }
    });
  }

  async searchJourneys(from: string, to: string, opts: SearchJourneysOptions): Promise<NormJourneysResult> {
    const payload = {
      from,
      to,
      opts: {
        departure: opts.departure?.toISOString(),
        arrival: opts.arrival?.toISOString(),
        results: opts.results ?? 5,
        via: opts.via,
        transfers: opts.transfers,
        transferTime: opts.transferTime,
        products: opts.products,
        tickets: opts.tickets ?? true,
        stopovers: opts.stopovers ?? true,
        klasse: opts.klasse,
      },
    };
    return this.limiter.schedule(async () => {
      try {
        const res = await this.call<{ journeys?: unknown[]; earlierRef?: string; laterRef?: string }>(
          "/api/journeys",
          { method: "POST", body: JSON.stringify(payload) },
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
    const key = `gw:refresh:${refreshToken}`;
    return this.limiter.dedupe(key, async () => {
      try {
        const res = await this.call<{ journey?: unknown } & Record<string, unknown>>("/api/refresh", {
          method: "POST",
          body: JSON.stringify({ refreshToken, opts: { tickets: opts?.tickets ?? true, stopovers: opts?.stopovers ?? true } }),
        });
        return mapJourney(res.journey ?? res);
      } catch (err) {
        throw normalizeError(err);
      }
    });
  }

  async getTrip(id: string): Promise<NormTrip> {
    const key = `gw:trip:${id}`;
    return this.limiter.dedupe(key, async () => {
      try {
        const res = await this.call<{ trip?: unknown } & Record<string, unknown>>(
          `/api/trip?id=${encodeURIComponent(id)}`,
          { method: "GET" },
        );
        return mapTrip(res.trip ?? res, id);
      } catch (err) {
        throw normalizeError(err);
      }
    });
  }

  async getDepartures(): Promise<NormDeparture[]> {
    // Departures are a routing concern handled by MOTIS; not exposed by the gateway.
    return [];
  }
}
