/**
 * "Nehme ich wahr?" — when a day has two bookings for the same journey (e.g. a
 * cheap backup ticket), the passenger marks the one they'll take. The others
 * then count as skipped; with no mark yet the day is "open" (decide!).
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
const GONE = new Set(["not_started", "cancelled", "moved"]);
/** Already happened. */
const RODE = new Set(["done", "delayed", "aborted"]);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9äöüß]/g, "");
const ms = (iso: string | null) => (iso ? new Date(iso).getTime() : NaN);

/** Same day and the same way (origin → destination), or overlapping in time. */
export function competing(a: PlanTrip, b: PlanTrip): boolean {
  if (a.id === b.id || a.date !== b.date) return false;
  if (norm(a.originName) === norm(b.originName) && norm(a.destName) === norm(b.destName)) return true;
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
    // A rival is taken → this one is the spare; all rivals skipped → this is the one.
    const theirs = rivals.map(own);
    const state: PlanState = theirs.includes("take") ? "skip" : theirs.every((p) => p === "skip") ? "take" : "open";
    out.set(t.id, { state, implied: true, rivals: rivals.map((r) => r.id) });
  }
  return out;
}

export const PLAN_LABEL: Record<Exclude<PlanState, null>, string> = {
  take: "Nehme ich",
  skip: "Nehme ich nicht",
  open: "Doppelt – welche nimmst du?",
};
