"use client";

import * as React from "react";
import { Sheet } from "@/components/Sheet";
import { Button, Input, Switch } from "@/components/ui";
import type { SearchFilters } from "@/lib/engine/types";

function NumField({
  label,
  value,
  onChange,
  suffix,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  suffix?: string;
}) {
  return (
    <label className="flex items-center justify-between gap-3 py-1">
      <span className="text-sm">{label}</span>
      <span className="flex items-center gap-1">
        <Input
          type="number"
          inputMode="numeric"
          className="h-9 w-24 text-right"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
        {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
      </span>
    </label>
  );
}

export function FiltersSheet({
  open,
  onClose,
  filters,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  filters: SearchFilters;
  onChange: (f: SearchFilters) => void;
}) {
  const set = <K extends keyof SearchFilters>(k: K, v: SearchFilters[K]) =>
    onChange({ ...filters, [k]: v });
  const [expert, setExpert] = React.useState(false);

  return (
    <Sheet open={open} onClose={onClose} title="Filter">
      <div className="space-y-1">
        {/* Always-on filters (nur buchbar, durchgehendes Ticket, ≥1 FV, ICE+IC)
            leben nur noch in DEFAULT_FILTERS = true — keine Schalter mehr. */}
        <Switch label="Nur Original-Fahrten (von der DB vorgeschlagen)" checked={filters.onlyOriginal} onChange={(v) => set("onlyOriginal", v)} />
        <Switch label="Nur günstiger als Referenz" checked={filters.belowReference} onChange={(v) => set("belowReference", v)} />
        <Switch label="Start-Fallback verwenden (auch ab Hbf suchen)" checked={filters.useFallback} onChange={(v) => set("useFallback", v)} />

        <div className="my-3 h-px bg-border" />

        <NumField label="Max. Preis" value={filters.maxPrice} onChange={(v) => set("maxPrice", v)} suffix="€" />
        <NumField label="Max. Gesamtdauer" value={filters.maxDurationMin} onChange={(v) => set("maxDurationMin", v)} suffix="min" />
        <NumField label="Max. Umstiege" value={filters.maxTransfers} onChange={(v) => set("maxTransfers", v)} />
        <NumField label="Max. ICE-Minuten" value={filters.maxFvMinutes} onChange={(v) => set("maxFvMinutes", v)} suffix="min" />
        <NumField label="Max. ICE-Halte" value={filters.maxFvStops} onChange={(v) => set("maxFvStops", v)} />
        <NumField label="Max. Fernverkehr-Abschnitte (0 = unbegrenzt)" value={filters.maxFvLegs} onChange={(v) => set("maxFvLegs", v)} />
        <NumField
          label="Min. Flex-Chance (≥ 20 min später, Statistik)"
          value={filters.minFlexPct}
          onChange={(v) => set("minFlexPct", v)}
          suffix="%"
        />
        <NumField
          label="Max. Anschluss-Quote (alle Umstiege klappen, Statistik)"
          value={filters.maxOkPct}
          onChange={(v) => set("maxOkPct", v)}
          suffix="%"
        />

        <button
          type="button"
          className="mt-3 text-sm font-medium text-primary"
          onClick={() => setExpert((e) => !e)}
        >
          {expert ? "Expertenoptionen ausblenden" : "Expertenoptionen anzeigen"}
        </button>
        {expert && (
          <div className="mt-2 space-y-1 rounded-xl bg-muted/40 p-3">
            <NumField label="Mindestumstieg" value={filters.minTransferMin} onChange={(v) => set("minTransferMin", v)} suffix="min" />
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
