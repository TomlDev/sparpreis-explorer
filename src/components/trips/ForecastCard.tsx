"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import type { TripRow } from "@/db/schema";
import { ReliabilityBadges } from "@/components/Reliability";
import { Button, Card, Input, Spinner } from "@/components/ui";
import { berlinToIso, formatTime } from "@/lib/time";
import type { Alternative } from "@/lib/trips/alternatives";
import { forecastText, tripForecast } from "@/lib/trips/forecast";
import { ticketSpan } from "@/lib/trips/rules";
import { cn } from "@/lib/utils";
import { legColor, legLabel } from "./tripUi";

const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : NaN);
const late = (planned: string | null, rt: string | null) => (planned && rt ? Math.round((ms(rt) - ms(planned)) / 60_000) : 0);
const fmtMin = (m: number | null) => (m == null ? "" : m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}` : `${m} min`);
const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });

function Time({ planned, rt }: { planned: string | null; rt: string | null }) {
  const d = late(planned, rt);
  return (
    <span className="tabular-nums">
      {formatTime(planned)}
      {d >= 1 && <span className={cn("ml-0.5 text-xs", d >= 5 ? "text-danger" : "text-warning")}>+{d}</span>}
    </span>
  );
}

/**
 * Live forecast of a trip and — once the Zugbindung is lifted — the next
 * connections to choose from (Flex): one tap links the pick as the journey made
 * on this ticket, the live tracking follows it.
 */
export function ForecastCard({ t }: { t: TripRow }) {
  const router = useRouter();
  const f = tripForecast(t.legs, t.reroute);
  const flexible = t.plan !== "take" || !!t.movedFrom;
  const show = t.status === "planned" && (t.date === today() || f.level !== "none");
  const [open, setOpen] = React.useState(false);
  const [data, setData] = React.useState<{ start: { name: string; underway: boolean }; when: string; alternatives: Alternative[] } | null>(null);
  const [at, setAt] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const load = React.useCallback(
    async (time?: string) => {
      setBusy("load");
      setErr(null);
      try {
        const iso = time ? berlinToIso(t.date === today() ? today() : t.date, time) : null;
        const res = await fetch(`/api/trips/${t.id}/alternatives${iso ? `?at=${encodeURIComponent(iso)}` : ""}`);
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error ?? "Laden fehlgeschlagen");
        setData(d);
        setAt(formatTime(d.when));
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [t.id, t.date],
  );

  // Zugbindung lifted on a trip you didn't commit to → suggest right away (and when opened via #ersatz).
  const suggest = show && flexible && f.level === "lifted";
  React.useEffect(() => {
    const linked = typeof window !== "undefined" && window.location.hash === "#ersatz";
    if ((suggest || linked) && !open) {
      setOpen(true);
      void load();
      if (linked) requestAnimationFrame(() => document.getElementById("ersatz")?.scrollIntoView({ block: "start" }));
    }
    // once per page view
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggest]);

  async function pick(a: Alternative) {
    setBusy(a.key);
    setErr(null);
    try {
      const res = await fetch(`/api/trips/${t.id}/alternatives`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: a.key }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? "Speichern fehlgeschlagen");
      router.push(`/reisen/${d.trip.id}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(null);
    }
  }

  if (!show) return null;
  const dest = ticketSpan(t).to;
  const seen = f.at ? new Date(f.at).toLocaleTimeString("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" }) : null;
  const tone = f.level === "lifted" ? "border-danger/50 bg-danger/5" : f.level === "late" || f.level === "check" ? "border-warning/50 bg-warning/5" : "";

  return (
    <Card id="ersatz" className={cn("scroll-mt-20 p-4", tone)}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Prognose</h2>
        {seen && <span className="text-xs text-muted-foreground">DB-Live-Daten {seen}</span>}
      </div>
      <p
        className={cn(
          "mt-1 font-medium",
          f.level === "lifted" ? "text-danger" : f.level === "late" || f.level === "check" ? "text-warning" : f.level === "ok" ? "text-success" : "",
        )}
      >
        {f.level === "none" ? "Noch keine Live-Daten – die App schaut ab 3 h vor Abfahrt bei jedem Zug nach." : forecastText(f, dest)}
      </p>
      {f.reason && f.delayMin != null && (f.level !== "ok" || f.breakAt) && <p className="text-sm text-muted-foreground">{f.reason}</p>}
      {t.reroute && f.breakAt && t.reroute.breakLeg === f.breakAt.legIndex && (
        <p className="text-xs text-muted-foreground">
          Geprüft {new Date(t.reroute.checkedAt).toLocaleTimeString("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" })} im
          DB-Live-Fahrplan: schnellste Weiterfahrt ab {t.reroute.from} nach {new Date(t.reroute.after).toLocaleTimeString("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" })}.
          Maßgeblich ist die Verspätung am Ziel – wird alle 10 min neu geprüft und als Beleg gespeichert.
        </p>
      )}
      {f.level === "lifted" && (
        <p className="mt-1 text-sm">
          {flexible
            ? "Du darfst mit deinem Ticket einen anderen Zug nehmen – auch später am Tag oder an einem anderen Tag."
            : "Du hast „Nehme ich“ gewählt – trotzdem darfst du einen anderen Zug nehmen."}{" "}
          Screenshot der Prognose aus der DB-App aufheben.
        </p>
      )}

      {!open ? (
        <Button
          size="sm"
          variant="outline"
          className="mt-3"
          onClick={() => {
            setOpen(true);
            void load();
          }}
        >
          Ersatzverbindungen anzeigen
        </Button>
      ) : (
        <div className="mt-3 border-t border-border pt-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Ab
              <Input type="time" className="h-9 w-28" value={at} onChange={(e) => setAt(e.target.value)} />
            </label>
            <Button size="sm" variant="outline" disabled={busy === "load"} onClick={() => load(at || undefined)}>
              {busy === "load" ? <Spinner /> : <RefreshCw className="h-4 w-4" />} Laden
            </Button>
            {data && (
              <span className="pb-2 text-xs text-muted-foreground">
                von {data.start.name}
                {data.start.underway ? " (hier bist du laut Plan)" : ""} nach {t.legs[t.legs.length - 1].toName}
              </span>
            )}
          </div>
          {err && <p className="mt-2 text-sm text-danger">{err}</p>}
          {data && !data.alternatives.length && <p className="mt-2 text-sm text-muted-foreground">Keine Verbindungen gefunden.</p>}
          <ul className="mt-2 divide-y divide-border">
            {data?.alternatives.map((a) => {
              const rides = a.legs.filter((l) => !l.walking);
              const earlier = t.plannedDeparture && ms(a.dep) < ms(t.plannedDeparture);
              const same = rides.length > 0 && rides.every((l) => t.legs.some((b) => b.lineName === l.line && b.plannedDeparture === l.dep));
              return (
                <li key={a.key} className={cn("py-2.5", a.cancelled && "opacity-50")}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-semibold">
                          <Time planned={a.dep} rt={a.depRt} />–<Time planned={a.arr} rt={a.arrRt} />
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {fmtMin(a.durationMin)} · {a.transfers} Umst.
                          {same && " · deine gebuchte Verbindung"}
                          {a.cancelled && " · fällt (teilweise) aus"}
                        </span>
                      </div>
                      {earlier && <div className="text-xs text-warning">früher als gebucht – ob das erlaubt ist, ist nicht eindeutig geregelt</div>}
                    </div>
                    {!same && (
                      <Button size="sm" className="shrink-0" disabled={!!busy} onClick={() => pick(a)}>
                        {busy === a.key ? <Spinner /> : "Nehme ich"}
                      </Button>
                    )}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    {a.reliability && (
                      <span className="contents [&>*]:whitespace-nowrap [&>*]:px-2 [&>*]:py-0.5">
                        <ReliabilityBadges rel={a.reliability} />
                      </span>
                    )}
                    {rides.map((l, i) => {
                      const leg = { product: l.product ?? undefined, lineName: l.line ?? undefined, fromName: l.from, toName: l.to, plannedDeparture: l.dep, plannedArrival: l.arr };
                      return (
                        <span key={i} className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold", legColor(leg), l.cancelled && "line-through")}>
                          {legLabel(leg)}
                        </span>
                      );
                    })}
                  </div>
                </li>
              );
            })}
          </ul>
          {data && data.alternatives.length > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              Ohne Preise – gilt mit deinem Ticket. Die gewählte Fahrt wird verknüpft eingetragen und live verfolgt; kommt sie ≥ 60 min
              zu spät an, gibt es dort Entschädigung.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
