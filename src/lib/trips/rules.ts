/**
 * Passenger rights (Fahrgastrechte) for a single ticket — as stated in DB's
 * own leaflet "Fahrgastrechte im Eisenbahnverkehr" and the official form
 * (Formular 2025). The app only ever claims what these rules give; anything
 * it cannot know (e.g. the reason for the delay) is surfaced as a caveat.
 *
 *  - ≥ 60 min late at the ticket's destination: 25 % of the (one-way) fare,
 *    ≥ 120 min: 50 %. Amounts below 4 € are not paid out.
 *  - Expected ≥ 60 min delay: don't travel → full refund; break off and
 *    return to the start → full refund; break off → refund of the unused part.
 *  - Expected ≥ 20 min delay: Zugbindung (e.g. Sparpreis) is lifted.
 *  - Exclusions under Art. 19(10) Reg. (EU) 2021/782 (extraordinary
 *    circumstances such as severe weather or third parties on the track) may
 *    be invoked by DB against the delay compensation.
 */

import type { TripLeg } from "@/db/schema";

const RAIL = new Set(["nationalExpress", "national", "regionalExpress", "regional", "suburban"]);
export const isRailLeg = (l: TripLeg) => !l.isWalking && RAIL.has(l.product ?? "");

/**
 * Passenger rights apply to the rail part of the ticket only (no tram, metro,
 * bus or walks): its first train's departure and last train's arrival are
 * the "Startbahnhof"/"Zielbahnhof" of the claim. Falls back to the whole trip.
 */
export function ticketSpan(t: { legs: TripLeg[]; originName: string; destName: string; plannedDeparture: string | null; plannedArrival: string | null }) {
  const rail = t.legs.filter(isRailLeg);
  if (!rail.length)
    return { from: t.originName, to: t.destName, departure: t.plannedDeparture, arrival: t.plannedArrival };
  return {
    from: rail[0].fromName,
    to: rail[rail.length - 1].toName,
    departure: rail[0].plannedDeparture,
    arrival: rail[rail.length - 1].plannedArrival,
  };
}

export type FormJourney = "delay" | "not_started" | "aborted_return" | "continued_extra";

export interface TripFacts {
  status: string; // planned | done | delayed | aborted | not_started | cancelled
  price: number | null;
  plannedArrival: string | null;
  actualArrival: string | null;
  /** Delay announced/expected at the destination when deciding not to travel / to abort. */
  expectedDelayMin?: number | null;
  /** Trip was broken off and the passenger returned to the start station. */
  returnedToStart?: boolean;
  /** Ticket was a round trip; `price` is then the whole ticket. */
  roundTrip?: boolean;
}

export interface Entitlement {
  /** Option on DB's paper form — null when the form has no fitting option
   *  (then: claim online / at a DB travel centre). */
  journey: FormJourney | null;
  title: string;
  /** € the passenger can expect (null = DB computes it, e.g. unused part). */
  amount: number | null;
  payable: boolean;
  details: string[];
  caveats: string[];
}

export const MIN_PAYOUT = 4;

export function arrivalDelayMin(plannedArrival: string | null, actualArrival: string | null): number | null {
  if (!plannedArrival || !actualArrival) return null;
  return Math.round((new Date(actualArrival).getTime() - new Date(plannedArrival).getTime()) / 60_000);
}

const eur = (n: number) => `${n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
/** pct of a fare in whole cents (no floating-point drift: 1.16 € × 25 % = 0.29 €). */
const share = (fare: number, pct: number) => Math.round(Math.round(fare * 100) * pct) / 100;

const ROUND_TRIP_REFUND =
  "Hin- und Rückfahrt: Wird dadurch die ganze Reise sinnlos, kann auch der volle Ticketpreis erstattet werden – das entscheidet die DB.";

export function assess(t: TripFacts): Entitlement | null {
  const fare = t.price != null ? (t.roundTrip ? t.price / 2 : t.price) : null;
  const fareNote = t.roundTrip ? "Grundlage: halber Preis des Hin- und Rückfahrt-Tickets." : null;

  if (t.status === "not_started" || t.status === "cancelled") {
    const exp = t.expectedDelayMin ?? null;
    const ok = t.status === "cancelled" || (exp != null && exp >= 60);
    return {
      journey: "not_started",
      title: t.status === "cancelled" ? "Erstattung: Zug fiel aus, Reise nicht angetreten" : "Erstattung: Reise nicht angetreten",
      amount: ok ? fare : null,
      payable: ok,
      details: [
        "Bei Zugausfall oder erwarteter Verspätung am Ziel von mind. 60 Minuten gibt es den Fahrpreis zurück, wenn du die Reise nicht antrittst.",
        ...(fareNote ? [fareNote, ROUND_TRIP_REFUND] : []),
      ],
      caveats: [
        ...(ok
          ? ["Belege (Screenshot der Ausfall-/Verspätungsmeldung) helfen."]
          : ["Nur bei Zugausfall oder erwarteter Verspätung ≥ 60 min – bitte erwartete Verspätung eintragen."]),
        "Bist du doch (später) gefahren, wähle „Verspätet angekommen“ – dann zählt die Verspätung am Ziel.",
      ],
    };
  }

  if (t.status === "aborted") {
    const exp = t.expectedDelayMin ?? null;
    const ok = exp != null && exp >= 60;
    const need = ok ? [] : ["Nur bei erwarteter Verspätung ≥ 60 min am Ziel – bitte eintragen."];
    if (t.returnedToStart) {
      return {
        journey: "aborted_return",
        title: "Erstattung: abgebrochen, zurück zum Start",
        amount: ok ? fare : null,
        payable: ok,
        details: ["Reise sinnlos geworden und zum Ausgangsbahnhof zurück: voller Fahrpreis.", ...(fareNote ? [fareNote, ROUND_TRIP_REFUND] : [])],
        caveats: need,
      };
    }
    // The paper form only knows "abgebrochen UND zurück zum Startbahnhof".
    return {
      journey: null,
      title: "Erstattung: Reise unterwegs abgebrochen",
      amount: null,
      payable: ok,
      details: ["Erstattet wird der Wert der nicht genutzten Strecke (berechnet die DB)."],
      caveats: [
        ...need,
        "Das Papierformular hat dafür kein passendes Feld – bitte online beantragen (bahn.de/fahrgastrechte bzw. DB Navigator: „Fahrtabbruch unterwegs“) oder im DB Reisezentrum.",
      ],
    };
  }

  const delay = arrivalDelayMin(t.plannedArrival, t.actualArrival);
  if (delay == null || delay < 60) return null;
  const pct = delay >= 120 ? 0.5 : 0.25;
  const amount = fare != null ? share(fare, pct) : null;
  const payable = amount == null || amount >= MIN_PAYOUT;
  return {
    journey: "delay",
    title: `Entschädigung: ${delay} min Verspätung am Ziel`,
    amount,
    payable,
    details: [
      `${pct * 100} % des Fahrpreises${fare != null ? ` (${eur(fare)})` : ""} ab ${delay >= 120 ? 120 : 60} min Verspätung.`,
      ...(fareNote ? [fareNote] : []),
    ],
    caveats: [
      ...(!payable ? [`Beträge unter ${MIN_PAYOUT} € zahlt die DB nicht aus.`] : []),
      "Bei außergewöhnlichen Umständen (z. B. Unwetter, Personen im Gleis) kann die DB die Entschädigung ablehnen.",
    ],
  };
}

/** Live hints while travelling (expected delay at the destination). */
export function liveHints(expectedDelayMin: number | null): string[] {
  if (expectedDelayMin == null) return [];
  const out: string[] = [];
  if (expectedDelayMin >= 20)
    out.push("≥ 20 min erwartet: Zugbindung aufgehoben – du darfst einen anderen Zug nehmen (Screenshot der Prognose machen).");
  if (expectedDelayMin >= 60)
    out.push("≥ 60 min erwartet: Entschädigung möglich, oder Fahrt abbrechen/nicht antreten und Fahrpreis zurück.");
  return out;
}
