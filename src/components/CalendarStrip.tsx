"use client";

import * as React from "react";
import { CalendarRange } from "lucide-react";
import { Button, Spinner } from "@/components/ui";
import { cn, formatEuro } from "@/lib/utils";

function addDays(date: string, n: number): string {
  const d = new Date(date + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function weekday(date: string): string {
  return new Date(date + "T12:00:00").toLocaleDateString("de-DE", { weekday: "short" });
}
function dayNum(date: string): string {
  return new Date(date + "T12:00:00").toLocaleDateString("de-DE", { day: "numeric", month: "numeric" });
}

export function CalendarStrip({
  baseDate,
  baseBody,
  onPick,
}: {
  baseDate: string;
  baseBody: Record<string, unknown>;
  onPick: (date: string) => void;
}) {
  const [prices, setPrices] = React.useState<Record<string, number | null>>({});
  const [loading, setLoading] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const days = React.useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(baseDate, i)), [baseDate]);

  async function scan() {
    setLoading(true);
    setDone(false);
    setPrices({});
    try {
      const params = new URLSearchParams({
        originKey: String(baseBody.originKey ?? ""),
        destKey: String(baseBody.destKey ?? ""),
        date: baseDate,
        days: "7",
      });
      const res = await fetch(`/api/bestprice?${params.toString()}`);
      if (res.ok) {
        const data: { days?: { date: string; price: number | null }[] } = await res.json();
        const map: Record<string, number | null> = {};
        for (const entry of data.days ?? []) {
          map[entry.date] = entry.price;
        }
        setPrices(map);
      }
    } catch {
      /* ignore */
    }
    setLoading(false);
    setDone(true);
  }

  const values = Object.values(prices).filter((p): p is number => p != null);
  const min = values.length ? Math.min(...values) : null;

  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <CalendarRange className="h-4 w-4" /> Woche vergleichen
        </div>
        <Button size="sm" variant="outline" onClick={scan} disabled={loading}>
          {loading ? <Spinner /> : done ? "Neu prüfen" : "Preise prüfen"}
        </Button>
      </div>
      <div className="scroll-x -mx-1 flex gap-2 px-1">
        {days.map((d) => {
          const price = prices[d];
          const isMin = price != null && price === min;
          return (
            <button
              key={d}
              onClick={() => onPick(d)}
              className={cn(
                "flex min-w-[64px] flex-1 flex-col items-center rounded-xl border p-2 text-center transition",
                d === baseDate ? "border-primary" : "border-border hover:bg-muted",
                isMin && "bg-success/10",
              )}
            >
              <span className="text-xs text-muted-foreground">{weekday(d)}</span>
              <span className="text-xs">{dayNum(d)}</span>
              <span className={cn("mt-1 text-sm font-semibold", isMin && "text-success")}>
                {loading && price === undefined ? "…" : price != null ? formatEuro(price) : "–"}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
