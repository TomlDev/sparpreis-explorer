"use client";

import * as React from "react";
import Link from "next/link";
import { Camera, Check, ChevronRight, ShieldCheck, TrainFront } from "lucide-react";
import type { TripRow } from "@/db/schema";
import { Button, Spinner, buttonClass } from "@/components/ui";
import { formatTime } from "@/lib/time";
import { forecastText, tripForecast } from "@/lib/trips/forecast";
import { cn } from "@/lib/utils";
import { legLabel, logControl, uploadFiles } from "./tripUi";

interface TodayTrip {
  trip: TripRow;
  phase: "before" | "underway" | "after";
  legIndex: number | null;
  nextIndex: number | null;
}

function inMinutes(iso: string | null, now: number): string {
  if (!iso) return "";
  const m = Math.round((new Date(iso).getTime() - now) / 60_000);
  if (m <= 0) return "jetzt";
  return m < 60 ? `in ${m} min` : `in ${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Shown on every page while a trip is today: where you are, quick actions. */
export function TodayBanner() {
  const [items, setItems] = React.useState<TodayTrip[]>([]);
  const [now, setNow] = React.useState(() => Date.now());
  const [msg, setMsg] = React.useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const uploadFor = React.useRef<string | null>(null);

  const load = React.useCallback(async () => {
    const d = await fetch("/api/trips/today").then((r) => (r.ok ? r.json() : { trips: [] }));
    setItems(d.trips ?? []);
    setNow(Date.now());
  }, []);
  React.useEffect(() => {
    load().catch(() => {});
    const t = setInterval(() => load().catch(() => {}), 60_000);
    return () => clearInterval(t);
  }, [load]);

  const flash = (text: string, ok = true) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), 4000);
  };
  // Let an open trip page refresh (checks, photos, status).
  const changed = () => window.dispatchEvent(new Event("trip-changed"));

  async function control(id: string) {
    if (busy) return; // GPS can take a few seconds — no double entries
    setBusy(`control-${id}`);
    try {
      const r = await logControl(id);
      flash(r.ok ? `Kontrolle gespeichert${r.withLocation ? " (mit Standort)" : " (ohne Standort)"}` : "Speichern fehlgeschlagen", r.ok);
      if (r.ok) {
        changed();
        // where the train was is looked up in the background — show it when it's there
        setTimeout(changed, 8000);
      }
    } catch {
      flash("Keine Verbindung – Kontrolle nicht gespeichert. Später auf der Fahrtseite nachtragen.", false);
    } finally {
      setBusy(null);
    }
  }
  async function markDone(id: string) {
    try {
      const res = await fetch(`/api/trips/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      });
      if (!res.ok) flash("Speichern fehlgeschlagen", false);
      changed();
    } catch {
      flash("Keine Verbindung", false);
    }
    load();
  }

  // The banner scrolls away with the page like any content; once it is behind the
  // sticky header, a one-line version shows right under the header — laid over the
  // page, so nothing moves (no jumping back and forth at the edge).
  const fullRef = React.useRef<HTMLDivElement>(null);
  const [compact, setCompact] = React.useState(false);
  const [top, setTop] = React.useState(56);
  const hasItems = items.some((i) => !(i.phase === "after" && i.trip.status !== "planned"));
  React.useEffect(() => {
    const el = fullRef.current;
    if (!el || !hasItems) return;
    let io: IntersectionObserver | null = null;
    const setup = () => {
      io?.disconnect();
      const h = Math.round(document.querySelector("header")?.getBoundingClientRect().height ?? 56);
      setTop(h);
      io = new IntersectionObserver(([e]) => setCompact(!e.isIntersecting && e.boundingClientRect.top < h), { rootMargin: `-${h}px 0px 0px 0px` });
      io.observe(el);
    };
    setup();
    window.addEventListener("resize", setup);
    return () => {
      io?.disconnect();
      window.removeEventListener("resize", setup);
    };
  }, [hasItems]);

  const visible = items.filter((i) => !(i.phase === "after" && i.trip.status !== "planned"));
  if (!visible.length) return null;

  let compactBar: React.ReactNode = null;
  {
    // the trip under way first, else the next one
    const main = visible.find((i) => i.phase === "underway") ?? visible[0];
    const t = main.trip;
    const leg = main.legIndex != null ? t.legs[main.legIndex] : null;
    const fc = t.status === "planned" ? tripForecast(t.legs, t.reroute, t.dbStatus) : null;
    compactBar = (
      <div className="fixed inset-x-0 z-30 border-b border-primary/20 bg-background/95 shadow-sm backdrop-blur" style={{ top }}>
        <button
          type="button"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          className="container flex w-full items-center gap-2 py-1.5 text-left text-xs"
          title="Alles anzeigen"
        >
          <TrainFront className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate">
            {/* what matters first — the station names may get cut off */}
            {fc?.level === "lifted" && <span className="font-semibold text-danger">⚠ Zugbindung aufgehoben · </span>}
            {fc?.level === "late" && <span className="font-semibold text-warning">+{fc.delayMin} min · </span>}
            {main.phase === "underway" ? (
              <>
                <b>Unterwegs</b>
                {leg ? ` ${legLabel(leg)} → ${leg.toName}` : ""}
              </>
            ) : (
              <>
                <b>{formatTime(t.plannedDeparture)}</b> → {t.destName} · {inMinutes(t.plannedDeparture, now)}
              </>
            )}
          </span>
          {visible.length > 1 && <span className="shrink-0 text-muted-foreground">+{visible.length - 1}</span>}
        </button>
      </div>
    );
  }

  return (
    <div ref={fullRef} className="border-b border-primary/20 bg-primary/5">
      {compact && compactBar}
      <input
        ref={fileRef}
        type="file"
        accept="image/*,application/pdf"
        multiple
        className="hidden"
        onChange={async (e) => {
          const id = uploadFor.current;
          if (!id || !e.target.files?.length) return;
          const n = e.target.files.length;
          try {
            const err = await uploadFiles(id, e.target.files);
            flash(err ?? `${n} Datei(en) gespeichert`, !err);
            changed();
          } catch {
            flash("Upload fehlgeschlagen – keine Verbindung", false);
          }
          e.target.value = "";
        }}
      />
      <div className="container space-y-1.5 py-2">
        {visible.map(({ trip: t, phase, legIndex, nextIndex }) => {
          const leg = legIndex != null ? t.legs[legIndex] : null;
          const next = nextIndex != null ? t.legs[nextIndex] : null;
          const fc = phase !== "after" && t.status === "planned" ? tripForecast(t.legs, t.reroute, t.dbStatus) : null;
          const dest = t.destName;
          // later today (> 1 h): one quiet line — the buttons only when it matters
          const later = phase === "before" && !!t.plannedDeparture && new Date(t.plannedDeparture).getTime() - now > 3600_000;
          if (later && !(fc && fc.level === "lifted"))
            return (
              <Link key={t.id} href={`/reisen/${t.id}`} className="flex items-center gap-2 truncate text-sm text-muted-foreground hover:text-foreground">
                <TrainFront className="h-4 w-4 shrink-0 text-primary" />
                <span className="truncate">
                  <b className="text-foreground">Heute {formatTime(t.plannedDeparture)}</b> → {t.destName} · {inMinutes(t.plannedDeparture, now)}
                </span>
              </Link>
            );
          return (
            <div key={t.id} className="flex flex-col gap-1.5 text-sm sm:flex-row sm:items-center sm:gap-3">
              <div className="flex min-w-0 flex-1 items-start gap-2">
              <TrainFront className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                {phase === "before" && (
                  <span>
                    <b>Heute {formatTime(t.plannedDeparture)}</b> {t.originName} → {t.destName} · Abfahrt{" "}
                    {inMinutes(t.plannedDeparture, now)}
                  </span>
                )}
                {phase === "underway" && (
                  <span>
                    <b>Unterwegs</b>
                    {leg && (
                      <>
                        : {legLabel(leg)} → {leg.toName}, an {formatTime(leg.plannedArrival)}
                      </>
                    )}
                    {next && next !== leg && (
                      <span className="text-muted-foreground">
                        {" "}
                        · weiter {formatTime(next.plannedDeparture)} {legLabel(next)}
                      </span>
                    )}
                  </span>
                )}
                {phase === "after" && (
                  <span>
                    <b>Wie lief die Fahrt</b> {formatTime(t.plannedDeparture)} {t.originName} → {t.destName}?
                  </span>
                )}
                {fc && (fc.level === "lifted" || fc.level === "late" || fc.level === "check" || !!fc.breakAt) && (
                  <Link
                    href={`/reisen/${t.id}#ersatz`}
                    className={cn("mt-0.5 line-clamp-2 font-medium", fc.level === "lifted" ? "text-danger" : "text-warning")}
                  >
                    {fc.level === "lifted" ? "⚠ " : fc.level === "check" ? "🔎 " : "⏱ "}
                    {forecastText(fc, dest)}
                    {fc.level === "lifted" && t.plan !== "take" && <span className="underline"> · Ersatz wählen</span>}
                  </Link>
                )}
              </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1.5 pl-6 sm:pl-0">
                {phase !== "after" ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy === `control-${t.id}`}
                      onClick={() => control(t.id)}
                      title="Fahrkartenkontrolle mit Zeit und Standort speichern"
                    >
                      {busy === `control-${t.id}` ? <Spinner /> : <ShieldCheck className="h-4 w-4" />} Kontrolle
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        uploadFor.current = t.id;
                        fileRef.current?.click();
                      }}
                      title="Screenshot oder Foto speichern"
                    >
                      <Camera className="h-4 w-4" />
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => markDone(t.id)}>
                    <Check className="h-4 w-4" /> Pünktlich angekommen
                  </Button>
                )}
                <Link href={`/reisen/${t.id}`} className={buttonClass("ghost", "sm")}>
                  {phase === "after" ? "Anders gelaufen" : "Details"} <ChevronRight className="h-4 w-4" />
                </Link>
              </div>
            </div>
          );
        })}
        {msg && <div className={cn("text-xs font-medium", msg.ok ? "text-success" : "text-danger")}>{msg.text}</div>}
      </div>
    </div>
  );
}
