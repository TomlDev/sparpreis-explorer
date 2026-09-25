import { userAgent } from "@/lib/config";
import { dlog } from "@/lib/log";
import { getLimiter, normalizeError } from "./rateLimiter";
import {
  ProviderError,
  type NormDeparture,
  type NormJourney,
  type NormJourneysResult,
  type NormLeg,
  type NormLocation,
  type NormStopover,
  type NormTrip,
  type RailProvider,
  type SearchJourneysOptions,
} from "./types";

/**
 * Routing provider backed by MOTIS v2/v3 (Transitous public instance by
 * default). Provides timetables, connections, stations and trips — but no
 * prices. Prices/tickets are the pricing provider's job. This keeps the
 * expensive, IP-blocked DB API out of the routing/graph-learning hot path.
 */

// MOTIS mode -> our product vocabulary (so FV detection etc. reuse unchanged).
const MODE_TO_PRODUCT: Record<string, string> = {
  HIGHSPEED_RAIL: "nationalExpress", // ICE / high speed
  LONG_DISTANCE: "national", // IC / EC (also FlixTrain)
  NIGHT_RAIL: "national",
  COACH: "bus",
  REGIONAL_FAST_RAIL: "regionalExpress",
  REGIONAL_RAIL: "regional",
  METRO: "suburban",
  SUBURBAN: "suburban",
  SUBWAY: "subway",
  TRAM: "tram",
  BUS: "bus",
  FERRY: "ferry",
  ODM: "taxi",
};

// Our product filter keys -> MOTIS transit modes (for the plan request).
const PRODUCT_TO_MODES: Record<string, string[]> = {
  nationalExpress: ["HIGHSPEED_RAIL"],
  national: ["LONG_DISTANCE", "NIGHT_RAIL"],
  regionalExpress: ["REGIONAL_FAST_RAIL"],
  regional: ["REGIONAL_RAIL"],
  suburban: ["SUBURBAN", "METRO"],
  subway: ["SUBWAY"],
  tram: ["TRAM"],
  bus: ["BUS", "COACH"],
  ferry: ["FERRY"],
  taxi: ["ODM"],
};

interface MotisPlace {
  name?: string;
  stopId?: string;
  lat?: number;
  lon?: number;
  arrival?: string;
  departure?: string;
  scheduledArrival?: string;
  scheduledDeparture?: string;
}

interface MotisLeg {
  mode: string;
  from: MotisPlace;
  to: MotisPlace;
  duration?: number;
  startTime?: string;
  endTime?: string;
  scheduledStartTime?: string;
  scheduledEndTime?: string;
  routeShortName?: string;
  displayName?: string;
  tripId?: string;
  agencyName?: string;
  headsign?: string;
  intermediateStops?: MotisPlace[];
}

interface MotisItinerary {
  duration?: number;
  startTime?: string;
  endTime?: string;
  transfers?: number;
  legs?: MotisLeg[];
}

export class MotisProvider implements RailProvider {
  readonly name = "motis";
  private base: string;
  private limiter = getLimiter("motis");

  constructor(base?: string) {
    this.base = (base || process.env.MOTIS_BASE || "https://api.transitous.org").replace(/\/$/, "");
  }

  private async get<T>(
    path: string,
    params: Record<string, string | number | boolean | undefined>,
    signal?: AbortSignal,
  ): Promise<T> {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    const url = `${this.base}${path}${qs ? `?${qs}` : ""}`;
    const started = Date.now();
    const res = await fetch(url, {
      headers: { "User-Agent": userAgent(), Accept: "application/json" },
      signal,
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      dlog("motis", `${path} -> ${res.status} (${ms}ms)`, { params });
      throw new ProviderError(`motis ${res.status}`, {
        status: res.status,
        isRateLimit: res.status === 429,
        isBlocked: res.status === 403,
        // Transitous is a flaky community instance: 404/5xx/429 are transient.
        retryable: res.status === 404 || res.status === 429 || res.status >= 500,
      });
    }
    dlog("motis", `${path} -> ${res.status} (${ms}ms)`);
    return (await res.json()) as T;
  }

  private place(id: string): string {
    // MOTIS accepts either a stopId or "lat,lon" as a place.
    return id;
  }

  async searchLocations(query: string, opts?: { results?: number }): Promise<NormLocation[]> {
    const key = `motis:geo:${query}:${opts?.results ?? 8}`;
    return this.limiter.dedupe(key, async () => {
      try {
        const res = await this.get<Array<{ type?: string; id?: string; name?: string; lat?: number; lon?: number }>>(
          "/api/v1/geocode",
          { text: query },
        );
        return (res || [])
          .filter((r) => r.id && r.name)
          .slice(0, opts?.results ?? 8)
          .map((r) => ({
            id: String(r.id),
            name: r.name!,
            type: r.type,
            lat: r.lat,
            lng: r.lon,
          }));
      } catch (err) {
        throw normalizeError(err);
      }
    });
  }

  async searchJourneys(from: string, to: string, opts: SearchJourneysOptions): Promise<NormJourneysResult> {
    const modes = this.buildModes(opts.products);
    const time = (opts.departure ?? opts.arrival ?? new Date()).toISOString();
    const params: Record<string, string | number | boolean | undefined> = {
      fromPlace: this.place(from),
      toPlace: this.place(to),
      time,
      arriveBy: opts.arrival ? true : false,
      numItineraries: opts.results ?? 5,
      transitModes: modes.join(","),
      maxTransfers: typeof opts.transfers === "number" && opts.transfers >= 0 ? opts.transfers : undefined,
      // MOTIS uses minTransferTime in seconds.
      minTransferTime: typeof opts.transferTime === "number" ? opts.transferTime * 60 : undefined,
      via: opts.via,
    };
    return this.limiter.schedule(async () => {
      try {
        const res = await this.get<{ itineraries?: MotisItinerary[] }>("/api/v3/plan", params, opts.signal);
        return { journeys: (res.itineraries || []).map((it) => this.mapItinerary(it)) };
      } catch (err) {
        throw normalizeError(err);
      }
    });
  }

  // MOTIS has no priced offers; refreshJourney is a no-op that returns nothing.
  async refreshJourney(): Promise<NormJourney> {
    throw new ProviderError("motis does not provide prices", { status: 501 });
  }

  async getTrip(id: string): Promise<NormTrip> {
    const key = `motis:trip:${id}`;
    return this.limiter.dedupe(key, async () => {
      try {
        const res = await this.get<{ legs?: MotisLeg[]; stopTimes?: unknown[] } & Record<string, unknown>>(
          "/api/v1/trip",
          { tripId: id },
        );
        const leg = res.legs?.[0];
        const stops: NormStopover[] = [];
        if (leg) {
          if (leg.from) stops.push(this.stopover(leg.from));
          for (const s of leg.intermediateStops ?? []) stops.push(this.stopover(s));
          if (leg.to) stops.push(this.stopover(leg.to));
        }
        return {
          id,
          product: leg ? MODE_TO_PRODUCT[leg.mode] : undefined,
          lineName: leg?.routeShortName ?? leg?.displayName,
          trainNumber: leg?.routeShortName,
          operator: leg?.agencyName,
          stops,
        };
      } catch (err) {
        throw normalizeError(err);
      }
    });
  }

  async getDepartures(
    stationId: string,
    opts?: { when?: Date; results?: number },
  ): Promise<NormDeparture[]> {
    const key = `motis:dep:${stationId}:${opts?.when?.toISOString() ?? "now"}`;
    return this.limiter.dedupe(key, async () => {
      try {
        const res = await this.get<{ stopTimes?: Array<{ place?: MotisPlace; mode?: string; tripId?: string; routeShortName?: string; headsign?: string }> }>(
          "/api/v1/stoptimes",
          { stopId: stationId, time: opts?.when?.toISOString(), n: opts?.results ?? 30 },
        );
        return (res.stopTimes || []).map((st) => ({
          tripId: st.tripId,
          product: st.mode ? MODE_TO_PRODUCT[st.mode] : undefined,
          lineName: st.routeShortName,
          trainNumber: st.routeShortName,
          direction: st.headsign ?? null,
          plannedWhen: st.place?.scheduledDeparture ?? st.place?.departure ?? null,
          when: st.place?.departure ?? null,
        }));
      } catch (err) {
        throw normalizeError(err);
      }
    });
  }

  private buildModes(filter?: SearchJourneysOptions["products"]): string[] {
    if (!filter) return Object.values(PRODUCT_TO_MODES).flat();
    const modes = new Set<string>();
    for (const [product, enabled] of Object.entries(filter)) {
      if (enabled && PRODUCT_TO_MODES[product]) PRODUCT_TO_MODES[product].forEach((m) => modes.add(m));
    }
    // Always allow walking-adjacent local modes so a routing is even possible.
    ["REGIONAL_RAIL", "SUBURBAN", "BUS", "TRAM", "SUBWAY"].forEach((m) => modes.add(m));
    return [...modes];
  }

  private stopover(p: MotisPlace): NormStopover {
    return {
      id: p.stopId ? String(p.stopId) : undefined,
      name: p.name ?? "?",
      plannedArrival: p.scheduledArrival ?? p.arrival ?? null,
      plannedDeparture: p.scheduledDeparture ?? p.departure ?? null,
    };
  }

  private mapLeg(leg: MotisLeg): NormLeg {
    const walking = leg.mode === "WALK" || !leg.tripId;
    let product = walking ? undefined : MODE_TO_PRODUCT[leg.mode] ?? "regional";
    if (!walking && /flix/i.test(`${leg.agencyName ?? ""} ${leg.routeShortName ?? ""}`)) {
      product = "flixtrain";
    }
    return {
      product,
      lineName: leg.routeShortName ?? leg.displayName,
      trainNumber: leg.routeShortName,
      operator: leg.agencyName,
      origin: { id: leg.from.stopId, name: leg.from.name ?? "?" },
      destination: { id: leg.to.stopId, name: leg.to.name ?? "?" },
      plannedDeparture: leg.scheduledStartTime ?? leg.startTime ?? null,
      plannedArrival: leg.scheduledEndTime ?? leg.endTime ?? null,
      departure: leg.startTime ?? null,
      arrival: leg.endTime ?? null,
      isWalking: walking,
      direction: leg.headsign ?? null,
      stopovers: (leg.intermediateStops ?? []).map((s) => this.stopover(s)),
    };
  }

  private mapItinerary(it: MotisItinerary): NormJourney {
    return {
      legs: (it.legs || []).map((l) => this.mapLeg(l)),
      refreshToken: null,
      price: null, // MOTIS never prices
      ticketInfo: null,
    };
  }
}
