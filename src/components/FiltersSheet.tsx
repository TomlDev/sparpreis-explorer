"use client";

import * as React from "react";
import { Sheet } from "@/components/Sheet";
import { Button, Input, Switch } from "@/components/ui";
import type { LimitKey, SearchFilters } from "@/lib/engine/types";
import { cn } from "@/lib/utils";

/** A limit with its own on/off box: off keeps the value but doesn't filter (typing switches it on again). */
function NumField({
  label,
  value,
  onChange,
  suffix,
  off,
  onOff,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  suffix?: string;
  off?: boolean;
  onOff?: (off: boolean) => void;
}) {
  const set = value != null && !(label.startsWith("Max. Fernverkehr") && value === 0);
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <label className={cn("flex min-w-0 items-center gap-2 text-sm", off && "text-muted-foreground")}>
        {onOff && (
          <input
            type="checkbox"
            className="h-4 w-4 shrink-0 accent-[hsl(var(--primary))]"
            checked={set && !off}
            disabled={!set}
            onChange={(e) => onOff(!e.target.checked)}
            aria-label={`${label} an/aus`}
            title={set ? (off ? "Filter einschalten" : "Filter kurz ausschalten") : "Kein Wert – filtert nicht"}
          />
        )}
        <span className={cn(off && "line-through decoration-muted-foreground/60")}>{label}</span>
      </label>
      <span className={cn("flex shrink-0 items-center gap-1", off && "opacity-50")}>
        <Input
          type="number"
          inputMode="numeric"
          className="h-9 w-24 text-right"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
        {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
      </span>
    </div>
  );
}

export function FiltersSheet({
  open,
  onClose,
  filters,
  onChange,
  off,
  onOff,
  onAllOff,
}: {
  open: boolean;
  onClose: () => void;
  filters: SearchFilters;
  onChange: (f: SearchFilters) => void;
  /** switched-off filters ("all" = every one) */
  off: string[];
  onOff: (key: string, off: boolean) => void;
  onAllOff: (off: boolean) => void;
}) {
  const set = <K extends keyof SearchFilters>(k: K, v: SearchFilters[K]) =>
    onChange({ ...filters, [k]: v });
  const allOff = off.includes("all");
  // each limit: its value plus an on/off box
  const lim = (k: LimitKey) => ({
    value: filters[k],
    onChange: (v: number | null) => set(k, v),
    off: allOff || off.includes(k),
    onOff: (o: boolean) => {
      if (allOff && !o) onAllOff(false);
      onOff(k, o);
    },
  });
  const [expert, setExpert] = React.useState(false);

  return (
    <Sheet open={open} onClose={onClose} title="Filter">
      <div className="space-y-1">
        <Switch label="Alle Filter kurz aus (Werte bleiben)" checked={allOff} onChange={onAllOff} />
        <p className="pb-1 text-xs text-muted-foreground">
          Oder einzeln: Haken weg = Filter aus, der Wert bleibt stehen. Neuer Wert = wieder an.
        </p>
        <div className="my-2 h-px bg-border" />
        {/* Always-on filters (nur buchbar, durchgehendes Ticket, ≥1 FV, ICE+IC)
            leben nur noch in DEFAULT_FILTERS = true — keine Schalter mehr. */}
        <Switch label="Nur Original-Fahrten (von der DB vorgeschlagen)" checked={filters.onlyOriginal} onChange={(v) => set("onlyOriginal", v)} />
        <Switch label="Nur günstiger als Referenz" checked={filters.belowReference} onChange={(v) => set("belowReference", v)} />
        <Switch label="Start-Fallback verwenden (auch ab Hbf suchen)" checked={filters.useFallback} onChange={(v) => set("useFallback", v)} />

        <div className="my-3 h-px bg-border" />

        <NumField label="Max. Preis" {...lim("maxPrice")} suffix="€" />
        <NumField label="Max. Gesamtdauer" {...lim("maxDurationMin")} suffix="min" />
        <NumField label="Max. Umstiege" {...lim("maxTransfers")} />
        <NumField label="Max. ICE-Minuten" {...lim("maxFvMinutes")} suffix="min" />
        <NumField label="Max. ICE-Halte" {...lim("maxFvStops")} />
        <NumField label="Max. Fernverkehr-Abschnitte (0 = unbegrenzt)" {...lim("maxFvLegs")} />
        <NumField label="Min. Flex-Chance (≥ 20 min später, Statistik)" {...lim("minFlexPct")} suffix="%" />
        <NumField label="Max. Anschluss-Quote (alle Umstiege klappen, Statistik)" {...lim("maxOkPct")} suffix="%" />

        <button
          type="button"
          className="mt-3 text-sm font-medium text-primary"
          onClick={() => setExpert((e) => !e)}
        >
          {expert ? "Expertenoptionen ausblenden" : "Expertenoptionen anzeigen"}
        </button>
        {expert && (
          <div className="mt-2 space-y-1 rounded-xl bg-muted/40 p-3">
            <NumField label="Mindestumstieg" {...lim("minTransferMin")} suffix="min" />
          </div>
        )}

        <div className="mt-5">
          <Button className="w-full" onClick={onClose}>
            Übernehmen
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
