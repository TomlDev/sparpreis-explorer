"use client";

import { Sheet } from "@/components/Sheet";
import { effectiveMinTransfer } from "@/lib/domain/ticketTransfers";
import type { SearchResult } from "@/lib/domain/result";
import { formatTime } from "@/lib/time";
import { formatDuration, formatEuro } from "@/lib/utils";

export function CompareView({
  open,
  onClose,
  results,
}: {
  open: boolean;
  onClose: () => void;
  results: SearchResult[];
}) {
  const rows: { label: string; render: (r: SearchResult) => string }[] = [
    { label: "Preis", render: (r) => formatEuro(r.coverage.price) },
    { label: "Abfahrt", render: (r) => formatTime(r.metrics.plannedDeparture) },
    { label: "Ankunft", render: (r) => formatTime(r.metrics.plannedArrival) },
    { label: "Dauer", render: (r) => formatDuration(r.metrics.durationMin) },
    { label: "ICE/IC", render: (r) => `${r.metrics.fvMinutes} min` },
    { label: "FV-Halte", render: (r) => String(r.metrics.fvStops) },
    { label: "FV-Anteil", render: (r) => `${r.metrics.fvPercent.toLocaleString("de-DE")} %` },
    { label: "Umstiege", render: (r) => String(r.metrics.transfers) },
    {
      label: "knappster Umstieg",
      render: (r) => (effectiveMinTransfer(r) != null ? `${effectiveMinTransfer(r)} min` : "–"),
    },
    {
      label: "Ticket",
      render: (r) =>
        ({
          green: "durchgehend",
          yellow: "unklar",
          red: "Teilstrecke",
          unpriced: "nicht geprüft",
          none: "kein Preis",
        } as const)[r.coverage.coverage],
    },
    { label: "Verlauf", render: (r) => r.chainLabel },
  ];

  return (
    <Sheet open={open} onClose={onClose} title={`Vergleich (${results.length})`}>
      <div className="scroll-x">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="sticky left-0 bg-card p-2 text-left"></th>
              {results.map((r, i) => (
                <th key={i} className="min-w-[120px] p-2 text-right font-semibold">
                  {String.fromCharCode(65 + i)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-t border-border">
                <td className="sticky left-0 bg-card p-2 text-left text-muted-foreground">{row.label}</td>
                {results.map((r, i) => (
                  <td key={i} className="p-2 text-right tabular-nums">
                    {row.render(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Sheet>
  );
}
