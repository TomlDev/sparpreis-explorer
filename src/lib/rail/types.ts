/**
 * Provider-agnostic normalized types. The rest of the application only ever
 * talks to these shapes — never to db-vendo-client / hafas structures directly.
 * That is the whole point of the abstraction (spec: "Provider-Abstraktion").
 */

export interface NormLocation {
  id: string;
  name: string;
  type?: string; // stop | station | poi | address
  lat?: number;
  lng?: number;
}

export interface NormStopover {
  id?: string;
  name: string;
  plannedArrival?: string | null;
  plannedDeparture?: string | null;
}

export interface NormLeg {
  product?: string; // nationalExpress | national | regionalExpress | ...
  lineName?: string; // "ICE 612"
  trainNumber?: string;
  operator?: string;
  origin: { id?: string; name: string };
  destination: { id?: string; name: string };
  plannedDeparture?: string | null; // ISO with offset
  plannedArrival?: string | null;
  departure?: string | null; // realtime
  arrival?: string | null;
  isWalking: boolean;
  stopovers?: NormStopover[];
  direction?: string | null;
}

export interface NormPrice {
  amount: number;
  currency: string;
  /** true when the offer is known to cover the full requested O→D. */
  fullRoute?: boolean;
  hint?: string | null;
}

export interface NormJourney {
  legs: NormLeg[];
  refreshToken?: string | null;
  price?: NormPrice | null;
  /** Any provider-specific ticket detail we managed to extract. */
  ticketInfo?: {
    fromName?: string;
    toName?: string;
    klasse?: number;
  } | null;
}

export interface NormJourneysResult {
  journeys: NormJourney[];
  /** Opaque tokens for paging earlier/later, if the provider supports it. */
  earlierRef?: string | null;
  laterRef?: string | null;
}

export interface NormTrip {
  id: string;
  product?: string;
  lineName?: string;
  trainNumber?: string;
  operator?: string;
  stops: NormStopover[];
}

export interface NormDeparture {
  tripId?: string;
  product?: string;
  lineName?: string;
  trainNumber?: string;
  direction?: string | null;
  plannedWhen?: string | null;
  when?: string | null;
}

export type ProductFilter = Partial<Record<string, boolean>>;

export interface SearchJourneysOptions {
  departure?: Date;
  arrival?: Date;
  results?: number;
  via?: string; // single via station id (hafas supports one)
  viaList?: string[]; // multiple via stations (DB `viaLocations` array); overrides `via`
  viaStopMinutes?: number; // min dwell (minutes) at the FIRST via (DB Navigator "Aufenthalt")
  transfers?: number; // max transfers (-1 = unlimited)
  transferTime?: number; // min transfer minutes
  products?: ProductFilter;
  tickets?: boolean;
  stopovers?: boolean;
  klasse?: 1 | 2;
  passengers?: number;
  bahncard?: string | null;
  deutschlandTicket?: boolean;
  signal?: AbortSignal;
}

export interface RailProvider {
  readonly name: string;
  searchLocations(query: string, opts?: { results?: number }): Promise<NormLocation[]>;
  searchJourneys(
    from: string,
    to: string,
    opts: SearchJourneysOptions,
  ): Promise<NormJourneysResult>;
  refreshJourney(
    refreshToken: string,
    opts?: { tickets?: boolean; stopovers?: boolean },
  ): Promise<NormJourney>;
  /** Optional: DB "Bestpreis" search — cheapest fares across the day. Only
   *  pricing providers implement this; used for the anchor + calendar. */
  searchBestPrices?(from: string, to: string, opts: SearchJourneysOptions): Promise<NormJourney[]>;
  getTrip(id: string): Promise<NormTrip>;
  getDepartures(
    stationId: string,
    opts?: { when?: Date; duration?: number; results?: number },
  ): Promise<NormDeparture[]>;
}

/** Thrown for transport-level failures so callers can distinguish them from
 *  application errors and apply backoff / show the "DB antwortet nicht" state. */
export class ProviderError extends Error {
  status?: number;
  isRateLimit: boolean;
  isBlocked: boolean;
  retryable: boolean;
  constructor(
    message: string,
    opts: {
      status?: number;
      isRateLimit?: boolean;
      isBlocked?: boolean;
      retryable?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.status = opts.status;
    this.isRateLimit = opts.isRateLimit ?? false;
    this.isBlocked = opts.isBlocked ?? false;
    this.retryable = opts.retryable ?? false;
  }
}
