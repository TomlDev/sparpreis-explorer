import type { TripRow } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/repo/settings";
import { forecastText, tripForecast, type Forecast } from "./forecast";
import { addEvent } from "./repo";
import { ticketSpan } from "./rules";

/**
 * When the live forecast of a trip crosses a line that matters, keep it as
 * evidence (an event on the trip — what DB said, and when). The trip page and
 * the today bar show it; notifications come from the DB app anyway.
 *  - a trip not marked "Nehme ich": Zugbindung lifted → time to pick another train;
 *  - a replacement journey: ≥ 60 min late → compensation.
 * Once per trip and step; again only when it gets clearly worse.
 */

interface Sent {
  kind: "lifted" | "claim";
  delay: number | null;
  reason: string | null;
  at: number;
}

const KEY = "forecastAlerts";
const MAX_KEEP = 200;

/** A trip whose Zugbindung matters to the user: not committed to this very train. */
export const isFlexible = (t: Pick<TripRow, "status" | "plan" | "movedFrom">) => t.status === "planned" && t.plan !== "take" && !t.movedFrom;

export function alertFor(t: TripRow, f: Forecast, prev: Sent | undefined): Sent | null {
  if (t.status !== "planned") return null;
  if (t.movedFrom) {
    if (f.delayMin == null || f.delayMin < 60) return null;
    if (prev && prev.kind === "claim" && f.delayMin - (prev.delay ?? 0) < 60) return null; // 120 min is the next step
    return { kind: "claim", delay: f.delayMin, reason: f.reason, at: Date.now() };
  }
  if (!isFlexible(t) || f.level !== "lifted") return null;
  if (prev?.kind === "lifted") {
    // again only when clearly worse: +20 min more, or the connection now breaks
    const worse = f.delayMin != null ? prev.delay != null && f.delayMin - prev.delay >= 20 : prev.delay != null;
    if (!worse) return null;
  }
  return { kind: "lifted", delay: f.delayMin, reason: f.reason, at: Date.now() };
}

export function checkForecastAlert(t: TripRow): void {
  const f = tripForecast(t.legs, t.reroute);
  const sent = getSetting<Record<string, Sent>>(KEY) ?? {};
  const next = alertFor(t, f, sent[t.id]);
  if (!next) return;
  const text = forecastText(f, ticketSpan(t).to);
  // evidence: what DB's live data said, and when
  const seen = f.at ? new Date(f.at).toLocaleTimeString("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" }) : "";
  addEvent(t.id, { type: "delay", at: f.at ?? Date.now(), text: `Prognose (DB-Live-Daten ${seen}): ${text}${f.reason && f.delayMin != null ? ` · ${f.reason}` : ""}` });
  const entries = Object.entries({ ...sent, [t.id]: next }).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_KEEP);
  setSetting(KEY, Object.fromEntries(entries));
}
