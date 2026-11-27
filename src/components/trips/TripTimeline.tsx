"use client";

import * as React from "react";
import type { TripLeg } from "@/db/schema";
import { formatTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { legColor, legLabel } from "./tripUi";

/** "RE42 (10102)" → "RE42": the number in brackets is on the trip page. */
const shortLabel = (l: TripLeg) => legLabel(l).replace(/\s*\(\d+\)$/, "");

const ROWS = 3;
const ROW_PX = 14;
const CHAR_PX = 6.3; // 11px system font, rough average
const GAP_PX = 6;

interface Seg {
  l: TripLeg;
  a: number;
  b: number;
}

/**
 * Place the train names under their part of the bar: longest legs first, each in
 * the first of up to three rows where it doesn't touch another name; what fits
 * nowhere is shown by its colour only.
 */
export function placeLabels(segs: Seg[], width: number): { i: number; text: string; left: number; row: number }[] {
  const rows: [number, number][][] = Array.from({ length: ROWS }, () => []);
  const out: { i: number; text: string; left: number; row: number }[] = [];
  const order = segs.map((s, i) => ({ s, i })).sort((x, y) => y.s.b - y.s.a - (x.s.b - x.s.a));
  for (const { s, i } of order) {
    const text = shortLabel(s.l);
    const w = text.length * CHAR_PX;
    const center = ((s.a + s.b) / 2) * width;
    const left = Math.max(0, Math.min(width - w, center - w / 2));
    const right = left + w;
    const row = rows.findIndex((r) => r.every(([x0, x1]) => right + GAP_PX <= x0 || left >= x1 + GAP_PX));
    if (row < 0) continue;
    rows[row].push([left, right]);
    out.push({ i, text, left, row });
  }
  return out;
}

/** The trip as one bar: each train as long as it runs, coloured like its badge, the names below. */
export function TripTimeline({ legs, from, to }: { legs: TripLeg[]; from: string; to: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(0);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const s = Date.parse(from);
  const span = Date.parse(to) - s;
  const segs: Seg[] =
    span > 0
      ? legs
          .filter((l) => !l.isWalking && l.plannedDeparture && l.plannedArrival)
          .map((l) => ({ l, a: Math.max(0, (Date.parse(l.plannedDeparture!) - s) / span), b: Math.min(1, (Date.parse(l.plannedArrival!) - s) / span) }))
          .filter((x) => x.b > x.a)
      : [];
  const labels = width ? placeLabels(segs, width) : [];
  const rowsUsed = labels.length ? Math.max(...labels.map((x) => x.row)) + 1 : 1;
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="shrink-0 tabular-nums leading-[10px]">{formatTime(from)}</span>
      <div ref={ref} className="relative min-w-0 flex-1" style={{ height: 12 + rowsUsed * ROW_PX }}>
        <div className="absolute inset-x-0 top-[4px] h-px bg-border" />
        {segs.map((x, i) => (
          <span
            key={i}
            className={cn("absolute top-0 h-[9px] rounded-[3px]", legColor(x.l))}
            style={{ left: `${x.a * 100}%`, width: `max(3px, calc(${(x.b - x.a) * 100}% - 2px))` }}
            title={legLabel(x.l)}
          />
        ))}
        {labels.map((x) => (
          <span
            key={x.i}
            className="absolute whitespace-nowrap text-[11px] leading-none text-muted-foreground"
            style={{ left: x.left, top: 13 + x.row * ROW_PX }}
          >
            {x.text}
          </span>
        ))}
      </div>
      <span className="shrink-0 tabular-nums leading-[10px]">{formatTime(to)}</span>
    </div>
  );
}
