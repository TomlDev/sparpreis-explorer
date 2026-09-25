"use client";

import * as React from "react";
import { toMin } from "@/lib/time";

const MIN = 0;
const MAX = 24 * 60;
const STEP = 15;

export { toMin };

/** minutes since midnight → "HH:mm". */
export function toHHmm(min: number): string {
  const clamped = ((min % MAX) + MAX) % MAX;
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Dual-knob time window (departure or arrival — the caller labels it). When the
 * start knob is dragged PAST the end knob it becomes an overnight window (e.g.
 * 23:00–01:00), shown as two segments.
 */
export function TimeRange({
  from,
  to,
  onChange,
  label = "Abfahrtsfenster",
  noun = "Abfahrt",
}: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  /** Header on the left (text or e.g. a departure/arrival toggle). */
  label?: React.ReactNode;
  /** What the knobs bound, for screen readers ("Abfahrt" / "Ankunft"). */
  noun?: string;
}) {
  const f = toMin(from);
  const t = toMin(to);
  const wrap = f > t;
  const pct = (v: number) => (v / MAX) * 100;
  const spanH = wrap ? (MAX - f + t) / 60 : (t - f) / 60;

  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span>{wrap ? "über Nacht" : `${Math.round(spanH * 10) / 10} h`}</span>
      </div>
      <div className="flex items-center justify-between text-base font-semibold tabular-nums">
        <span>{from}</span>
        <span className="text-muted-foreground">–</span>
        <span>
          {to}
          {wrap && <span className="ml-0.5 text-xs font-normal text-muted-foreground">+1 Tag</span>}
        </span>
      </div>
      <div className="relative mt-2 h-6 select-none">
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-muted" />
        {wrap ? (
          <>
            <div
              className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-l-full bg-primary"
              style={{ left: `${pct(f)}%`, right: 0 }}
            />
            <div
              className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-r-full bg-primary"
              style={{ left: 0, width: `${pct(t)}%` }}
            />
          </>
        ) : (
          <div
            className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-primary"
            style={{ left: `${pct(f)}%`, width: `${pct(t - f)}%` }}
          />
        )}
        <input
          className="rangeThumb"
          type="range"
          min={MIN}
          max={MAX}
          step={STEP}
          value={f}
          aria-label={`${noun} frühestens`}
          onChange={(e) => onChange(toHHmm(Number(e.target.value)), to)}
        />
        <input
          className="rangeThumb"
          type="range"
          min={MIN}
          max={MAX}
          step={STEP}
          value={t}
          aria-label={`${noun} spätestens`}
          onChange={(e) => onChange(from, toHHmm(Number(e.target.value)))}
        />
      </div>
      <div className="mt-0.5 flex justify-between text-[10px] text-muted-foreground">
        <span>00:00</span>
        <span>12:00</span>
        <span>24:00</span>
      </div>
    </div>
  );
}
