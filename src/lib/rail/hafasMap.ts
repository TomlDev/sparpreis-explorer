/**
 * Shared FPTF/hafas → normalized mappers. Both the direct db-vendo-client
 * provider and the db-rest HTTP provider return the same FPTF shapes, so the
 * mapping lives here once.
 */
import type {
  NormDeparture,
  NormJourney,
  NormLeg,
  NormLocation,
  NormStopover,
  NormTrip,
} from "./types";

function s(v: unknown): string | undefined {
  return v == null ? undefined : String(v);
}

export function mapLocation(l: unknown): NormLocation | null {
  const o = l as {
    id?: string;
    extId?: string;
    name?: string;
    type?: string;
    location?: { latitude?: number; longitude?: number };
    latitude?: number;
    longitude?: number;
  };
  if (!o) return null;
  const id = o.id ?? o.extId;
  const name = o.name;
  if (!id || !name) return null;
  return {
    id: String(id),
    name,
    type: o.type,
    lat: o.location?.latitude ?? o.latitude,
    lng: o.location?.longitude ?? o.longitude,
  };
}

export function mapStopover(so: unknown): NormStopover {
  const o = so as {
    stop?: { id?: string; name?: string };
    plannedArrival?: string;
    plannedDeparture?: string;
    arrival?: string;
    departure?: string;
  };
  return {
    id: o.stop?.id ? String(o.stop.id) : undefined,
    name: o.stop?.name ?? "?",
    plannedArrival: o.plannedArrival ?? o.arrival ?? null,
    plannedDeparture: o.plannedDeparture ?? o.departure ?? null,
  };
}

export function mapLeg(leg: unknown): NormLeg {
  const o = leg as {
    origin?: { id?: string; name?: string };
    destination?: { id?: string; name?: string };
    departure?: string;
    plannedDeparture?: string;
    arrival?: string;
    plannedArrival?: string;
    line?: {
      name?: string;
      fahrtNr?: string | number;
      product?: string;
      operator?: { name?: string };
    };
    walking?: boolean;
    direction?: string;
    stopovers?: unknown[];
  };
  const walking = !!o.walking || !o.line;
  return {
    product: o.line?.product,
    lineName: o.line?.name,
    trainNumber: s(o.line?.fahrtNr),
    operator: o.line?.operator?.name,
    origin: { id: s(o.origin?.id), name: o.origin?.name ?? "?" },
    destination: { id: s(o.destination?.id), name: o.destination?.name ?? "?" },
    plannedDeparture: o.plannedDeparture ?? o.departure ?? null,
    plannedArrival: o.plannedArrival ?? o.arrival ?? null,
    departure: o.departure ?? null,
    arrival: o.arrival ?? null,
    isWalking: walking,
    direction: o.direction ?? null,
    stopovers: Array.isArray(o.stopovers) ? o.stopovers.map(mapStopover) : undefined,
  };
}

export function mapJourney(j: unknown): NormJourney {
  const o = j as {
    legs?: unknown[];
    refreshToken?: string;
    price?: { amount?: number; currency?: string; hint?: string } | null;
  };
  const price =
    o.price && typeof o.price.amount === "number"
      ? {
          amount: o.price.amount,
          currency: o.price.currency ?? "EUR",
          hint: o.price.hint ?? null,
          // DB pricing providers (dbnav/dbrest/gateway) price the through
          // connection O→D that was searched, so a returned price is a valid
          // through-ticket. Only these providers use this mapper.
          fullRoute: true,
        }
      : null;
  return {
    legs: Array.isArray(o.legs) ? o.legs.map(mapLeg) : [],
    refreshToken: o.refreshToken ?? null,
    price,
    ticketInfo: null,
  };
}

export function mapTrip(res: unknown, fallbackId: string): NormTrip {
  const r = res as { trip?: unknown } & Record<string, unknown>;
  const trip = (r.trip ?? r) as {
    id?: string;
    line?: { name?: string; fahrtNr?: string | number; product?: string; operator?: { name?: string } };
    stopovers?: unknown[];
  };
  return {
    id: String(trip.id ?? fallbackId),
    product: trip.line?.product,
    lineName: trip.line?.name,
    trainNumber: s(trip.line?.fahrtNr),
    operator: trip.line?.operator?.name,
    stops: Array.isArray(trip.stopovers) ? trip.stopovers.map(mapStopover) : [],
  };
}

export function mapDeparture(d: unknown): NormDeparture {
  const o = d as {
    tripId?: string;
    line?: { name?: string; fahrtNr?: string | number; product?: string };
    direction?: string;
    plannedWhen?: string;
    when?: string;
  };
  return {
    tripId: o.tripId,
    product: o.line?.product,
    lineName: o.line?.name,
    trainNumber: s(o.line?.fahrtNr),
    direction: o.direction ?? null,
    plannedWhen: o.plannedWhen ?? o.when ?? null,
    when: o.when ?? null,
  };
}
