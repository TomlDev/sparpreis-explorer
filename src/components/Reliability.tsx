"use client";

import type { Reliability, ReliabilityTransfer } from "@/lib/delay/reliability";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui";

const pct = (p: number) => `${Math.round(p * 100)} %`;

const BASIS: Record<Reliability["basis"], string> = {
  train: "Zugnummer",
  line_hour: "Linie zur Uhrzeit",
  line: "Linie",
  station: "Bahnhof",
};

export function reliabilitySummary(rel: Reliability): string {
  const parts = [
    `Alles klappt: ${pct(rel.okPct)}`,
    `≥ 20 min später am Ziel (Zugbindung aufgehoben): ≈ ${pct(rel.flexPct)}`,
  ];
  if (rel.cancelPct >= 0.005) parts.push(`Mind. ein Zug fällt (teilweise) aus: ${pct(rel.cancelPct)}`);
  // Only the last train's own delay — broken connections / cancellations come on top (they drive the Flex chance).
  if (rel.arrP50 != null)
    parts.push(
      `Letzter Zug bis ${rel.arrAt ?? "zum Ziel"}, wenn alle Anschlüsse klappen: Median +${rel.arrP50} min, 80 % ≤ +${rel.arrP80} min`,
    );
  parts.push(`Basis: ${BASIS[rel.basis]} (≥ ${rel.samples} Fahrten)${rel.complete ? "" : ", nicht alle Züge in den Daten"}`);
  return parts.join("\n");
}

/**
 * "Anschluss" = chance every transfer holds. For Flex hunting low is good (a
 * connection that breaks lifts the Zugbindung): < 5 % red, < 10 % strong,
 * < 15 % medium, < 25 % dark green.
 */
export function connectionTone(okPct: number): string | undefined {
  if (okPct < 0.05) return "bg-danger text-white";
  if (okPct < 0.1) return "bg-success text-white";
  if (okPct < 0.15) return "bg-success/50 text-foreground";
  if (okPct < 0.25) return "bg-green-900 text-green-50 dark:bg-green-800";
  return undefined;
}

/** Compact chips for the result card. */
export function ReliabilityBadges({ rel }: { rel: Reliability | null | undefined }) {
  if (!rel) return null;
  const title = `${reliabilitySummary(rel)}\n\nSchätzung aus vergangenen Monaten (Open Data), keine Garantie.`;
  return (
    <>
      {rel.transfers.length > 0 && (
        <Badge variant="muted" className={connectionTone(rel.okPct)} title={title}>
          Anschluss {pct(rel.okPct)}
        </Badge>
      )}
      <Badge variant={rel.flexPct >= 0.3 ? "primary" : "outline"} title={title}>
        🎲 Flex {pct(rel.flexPct)}
        {!rel.complete && "*"}
      </Badge>
    </>
  );
}

/** Transfer to show in itinerary row i: on the first walk after the arriving
 *  train (where the transfer time is shown), else on the connecting train. */
export function transferInto(rel: Reliability | null | undefined, i: number): ReliabilityTransfer | null {
  if (!rel) return null;
  return rel.transfers.find((t) => t.afterLeg + 1 === i) ?? null;
}

export function MissChance({ t }: { t: ReliabilityTransfer }) {
  return (
    <span
      className={cn(
        "tabular-nums text-[10px] leading-tight",
        t.missPct >= 0.25 ? "font-bold text-red-700 dark:text-red-400" : t.missPct >= 0.1 ? "text-warning" : "text-muted-foreground",
      )}
      title={`Historisch verpasst in ≈ ${pct(t.missPct)} der Fälle${t.headwayMin ? ` · nächster Zug der Linie ≈ alle ${t.headwayMin} min` : ""}`}
    >
      {pct(t.missPct)} weg
    </span>
  );
}

/** What the punctuality numbers are — and the data source (CC BY 4.0 asks for attribution). */
export const RELIABILITY_NOTE =
  "Schätzung aus vergangenen Monaten (Open Data: piebro/deutsche-bahn-data, DB, CC BY 4.0), keine Aussage über den konkreten Zug. Ob die Zugbindung aufgehoben ist, entscheidet die tatsächliche Verspätung.";

/** One-paragraph explanation below the itinerary. */
export function ReliabilityDetails({ rel }: { rel: Reliability | null | undefined }) {
  if (!rel) return null;
  return (
    <div className="mt-4 text-xs text-muted-foreground">
      {/* own toggle — the tap must not collapse the result card around it */}
      <details className="group" onClick={(e) => e.stopPropagation()}>
        <summary className="cursor-pointer list-none font-semibold uppercase tracking-wide [&::-webkit-details-marker]:hidden">
          Pünktlichkeit (Statistik){" "}
          <span className="ml-1 font-normal normal-case text-primary underline group-open:no-underline" aria-label="Was heißt das?">
            ⓘ Was heißt das?
          </span>
        </summary>
        <p className="mt-1 text-[11px] normal-case">{RELIABILITY_NOTE}</p>
      </details>
      <p className="mt-1 whitespace-pre-line">{reliabilitySummary(rel)}</p>
    </div>
  );
}
