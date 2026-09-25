/** Minimal leg shape needed to compute transfer times in the itinerary. */
export interface WaitLeg {
  isWalking: boolean;
  plannedDeparture: string | null;
  plannedArrival: string | null;
}

/** Time shown left of a walk. Between two rides it's the REAL transfer time —
 *  previous arrival → next departure, walk included (same as "knappster
 *  Umstieg" on the card). Before the first ride it's just the buffer at the
 *  stop. Consecutive walks show it once, on the first. */
export function walkWait(legs: WaitLeg[], i: number): { min: number; transfer: boolean } | null {
  if (!legs[i].isWalking) return null;
  const prev = legs[i - 1];
  if (prev?.isWalking) return null; // already shown on the first walk of the group
  let j = i + 1;
  while (j < legs.length && legs[j].isWalking) j++;
  const nextRide = legs[j];
  if (!nextRide?.plannedDeparture) return null;
  const from = prev ? prev.plannedArrival : (legs[j - 1].plannedArrival ?? legs[j - 1].plannedDeparture);
  if (!from) return null;
  const min = Math.round((new Date(nextRide.plannedDeparture).getTime() - new Date(from).getTime()) / 60000);
  return { min, transfer: !!prev };
}

/** ≤5 min: bold red · 6–7 min: bold darker red · otherwise muted. */
export function waitClass(w: { min: number; transfer: boolean }): string {
  if (w.transfer && w.min <= 5) return "font-bold text-transfer-critical";
  if (w.transfer && w.min <= 7) return "font-bold text-transfer-tight";
  return "font-normal text-muted-foreground";
}
