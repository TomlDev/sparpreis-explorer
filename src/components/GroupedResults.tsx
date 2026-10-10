"use client";

import * as React from "react";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import type { SearchResult } from "@/lib/domain/result";
import { effectiveMinTransfer } from "@/lib/domain/ticketTransfers";
import { ReliabilityBadges } from "./Reliability";
import { formatTime } from "@/lib/time";
import { cn, formatDuration, formatEuro } from "@/lib/utils";

/**
 * Results grouped by price (Flex-Tag default): each group lists its connections
 * as one compact line each; opening a group shows the full cards of that group.
 */
export function GroupedResults({
  results,
  renderCard,
}: {
  results: SearchResult[];
  renderCard: (r: SearchResult) => React.ReactNode;
}) {
  const groups = React.useMemo(() => {
    const byPrice = new Map<string, SearchResult[]>();
    for (const r of results) {
      const key = r.coverage.price == null ? "none" : String(Math.round(r.coverage.price * 100));
      byPrice.set(key, [...(byPrice.get(key) ?? []), r]);
    }
    return [...byPrice.entries()]; // order of first appearance = the chosen sorting
  }, [results]);
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  return (
    <div className="space-y-3">
      {groups.map(([key, list]) => {
        const price = list[0].coverage.price;
        const isOpen = open.has(key);
        return (
          <section key={key} className="rounded-2xl border border-border bg-card shadow-sm">
            <button
              type="button"
              onClick={() => toggle(key)}
              aria-expanded={isOpen}
              className="flex w-full items-center justify-between gap-2 rounded-t-2xl px-4 py-2 text-left text-xs text-muted-foreground hover:bg-muted/50"
            >
              <span>
                <b className="text-sm text-foreground">{price != null ? formatEuro(price) : "ohne Preis"}</b> ·{" "}
                {list.length} {list.length === 1 ? "Verbindung" : "Verbindungen"}
              </span>
              <span className="inline-flex items-center gap-1">
                {isOpen ? "Details ausblenden" : "Details"}
                {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </span>
            </button>
            {isOpen ? (
              <div className="space-y-3 border-t border-border p-2">{list.map((r) => renderCard(r))}</div>
            ) : (
              <ul className="divide-y divide-border border-t border-border">
                {list.map((r) => (
                  <li key={r.fingerprint + r.variant}>
                    <CompactRow r={r} onOpen={() => toggle(key)} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** One connection in a line: Anschluss / Flex first, then times, duration, transfers, tightest transfer, price — route below. */
function CompactRow({ r, onOpen }: { r: SearchResult; onOpen: () => void }) {
  const m = r.metrics;
  const tight = effectiveMinTransfer(r);
  return (
    <button type="button" onClick={onOpen} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/50">
      {/* desktop: a column in front */}
      {r.reliability && (
        <div className="hidden w-[7.5rem] shrink-0 flex-col items-start gap-1 sm:flex [&>*]:whitespace-nowrap [&>*]:px-2 [&>*]:py-0.5">
          <ReliabilityBadges rel={r.reliability} />
        </div>
      )}
      <div className="min-w-0 flex-1">
        {/* phone: a row on top, so the times keep their width */}
        {r.reliability && (
          <div className="mb-1 flex flex-wrap gap-1 sm:hidden [&>*]:whitespace-nowrap [&>*]:px-2 [&>*]:py-0.5">
            <ReliabilityBadges rel={r.reliability} />
          </div>
        )}
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-semibold tabular-nums">
            {formatTime(m.plannedDeparture)}–{formatTime(m.plannedArrival)}
          </span>
          <span className="text-xs text-muted-foreground">
            {formatDuration(m.durationMin)} · {m.transfers} Umst.{tight != null ? ` · knappster ${tight} min` : ""}
          </span>
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {m.originName} → {m.destinationName}
          {r.earlyExit && <span className="font-medium text-primary"> · 🚪 Ticket bis {r.earlyExit.ticketTo}</span>}
          {!r.earlyExit && !!r.coverage.uncoveredLegs?.length && (
            <span className="font-medium text-foreground">
              {" "}
              · 🎫 gilt nur {r.coverage.offerFromName} – {r.coverage.offerToName}
            </span>
          )}
          {r.coverage.price != null && !r.coverage.spanChecked && <span className="font-medium text-warning"> · ⚠ Geltungsbereich ungeprüft</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {r.coverage.coverage === "green" && <Check className="h-4 w-4 text-success" />}
        <div className="text-right">
          <div className={cn("text-lg font-bold leading-none tabular-nums")}>
            {r.coverage.price != null ? formatEuro(r.coverage.price) : "–"}
          </div>
          <div className="text-[10px] text-muted-foreground">{r.coverage.klasse === 1 ? "1." : "2."} Kl.</div>
        </div>
        <ChevronDown className="h-4 w-4 text-muted-foreground" />
      </div>
    </button>
  );
}
