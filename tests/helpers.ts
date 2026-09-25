import type { NormJourney, NormLeg } from "@/lib/rail/types";

const DAY = "2026-10-18";

export function leg(
  product: string | null,
  fromName: string,
  toName: string,
  depMin: number,
  arrMin: number,
  opts: { trainNumber?: string; lineName?: string; stops?: number; delayMin?: number } = {},
): NormLeg {
  const base = new Date(`${DAY}T06:00:00+02:00`).getTime();
  const planDep = new Date(base + depMin * 60000).toISOString();
  const planArr = new Date(base + arrMin * 60000).toISOString();
  const d = opts.delayMin ?? 0;
  return {
    product: product ?? undefined,
    lineName: opts.lineName ?? (product ? `${product} ${opts.trainNumber ?? ""}`.trim() : undefined),
    trainNumber: opts.trainNumber,
    origin: { id: fromName, name: fromName },
    destination: { id: toName, name: toName },
    plannedDeparture: planDep,
    plannedArrival: planArr,
    departure: new Date(base + (depMin + d) * 60000).toISOString(),
    arrival: new Date(base + (arrMin + d) * 60000).toISOString(),
    isWalking: product === null,
    stopovers:
      opts.stops != null
        ? Array.from({ length: opts.stops + 2 }, (_, i) => ({ name: `${fromName}-s${i}` }))
        : [],
  };
}

export function journey(
  legs: NormLeg[],
  price: number | null,
  opts: { fullRoute?: boolean; offerFrom?: string; offerTo?: string } = {},
): NormJourney {
  return {
    legs,
    refreshToken: "t",
    price:
      price == null
        ? null
        : { amount: price, currency: "EUR", fullRoute: opts.fullRoute, hint: null },
    ticketInfo:
      opts.offerFrom || opts.offerTo
        ? { fromName: opts.offerFrom, toName: opts.offerTo, klasse: 2 }
        : null,
  };
}
