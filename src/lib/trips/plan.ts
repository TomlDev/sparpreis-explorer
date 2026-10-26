/**
 * "Nehme ich wahr?" — two bookings that overlap in time can't both be taken.
 * Until one is chosen both are ordinary trips, marked "doppelt gebucht" with a
 * way to decide ("open"). Taking one makes the other a skipped spare; skipping
 * one (or both — taking neither is fine) changes nothing about the other.
 */

export type Plan = "take" | "skip";
export type PlanState = "take" | "skip" | "open" | null;

export interface PlanTrip {
  id: string;
  date: string;
  originName: string;
  destName: string;
  plannedDeparture: string | null;
  plannedArrival: string | null;
  status: string;
  plan?: string | null;
}

export interface PlanInfo {
  state: PlanState;
  /** state follows from another trip's mark (or from the status), not its own */
  implied: boolean;
  /** competing trips of the same day */
  rivals: string[];
}

/** Didn't / won't happen as booked. */
const GONE = new Set(["not_started", "cancelled", "moved", "lifted"]);
/** Already happened. */
const RODE = new Set(["done", "delayed", "aborted"]);

const ms = (iso: string | null) => (iso ? new Date(iso).getTime() : NaN);

/** Overlapping in time — only then can't both be taken. (Not: just the same day / way.) */
export function competing(a: PlanTrip, b: PlanTrip): boolean {
  if (a.id === b.id) return false;
  const [a0, a1, b0, b1] = [ms(a.plannedDeparture), ms(a.plannedArrival), ms(b.plannedDeparture), ms(b.plannedArrival)];
  return [a0, a1, b0, b1].every(Number.isFinite) && a0 < b1 && b0 < a1;
}

const own = (t: PlanTrip): Plan | null =>
  GONE.has(t.status) ? "skip" : RODE.has(t.status) ? "take" : t.plan === "take" || t.plan === "skip" ? t.plan : null;

export function planStates(list: PlanTrip[]): Map<string, PlanInfo> {
  const out = new Map<string, PlanInfo>();
  for (const t of list) {
    const rivals = list.filter((o) => competing(t, o));
    const mine = own(t);
    const explicit = t.plan === "take" || t.plan === "skip";
    if (mine) {
      out.set(t.id, { state: mine, implied: !explicit || GONE.has(t.status) || RODE.has(t.status), rivals: rivals.map((r) => r.id) });
      continue;
    }
    if (!rivals.length) {
      out.set(t.id, { state: null, implied: false, rivals: [] });
      continue;
    }
    // A rival is taken → this one is the spare. Rivals left out (skipped / not taking) → an
    // ordinary trip again. Otherwise still to decide.
    const theirs = rivals.map(own);
    const state: PlanState = theirs.includes("take") ? "skip" : theirs.every((p) => p === "skip") ? null : "open";
    out.set(t.id, { state, implied: state !== null, rivals: rivals.map((r) => r.id) });
  }
  return out;
}

export const PLAN_LABEL: Record<Exclude<PlanState, null>, string> = {
  take: "Nehme ich",
  skip: "Nehme ich nicht",
  open: "Doppelt – welche nimmst du?",
};
