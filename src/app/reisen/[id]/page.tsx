"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Camera, ChevronDown, FileDown, FileText, MapPin, Pencil, ShieldCheck, StickyNote, Trash2 } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { Button, Card, Input, Spinner } from "@/components/ui";
import { EventDialog } from "@/components/trips/EventDialog";
import { ForecastCard } from "@/components/trips/ForecastCard";
import { STATUS, legColor, legLabel, mapsLink, uploadFiles } from "@/components/trips/tripUi";
import type { AttachmentRow, ClaimRow, TripEventRow, TripRow } from "@/db/schema";
import { berlinDay, berlinToIso, formatTime, todayLocal } from "@/lib/time";
import { delayMin, realtimeSummary, type RealtimeSummary } from "@/lib/trips/realtime";
import { planStates, type PlanInfo } from "@/lib/trips/plan";
import { tripTicketCover, type TripCover } from "@/lib/trips/ticketCover";
import { arrivalDelayMin, assess, liftedUsableUntil, liveHints, movedNotes, onlineClaimType, ticketSpan, type OnlineClaimType } from "@/lib/trips/rules";
import { cn, formatEuro } from "@/lib/utils";

type TripRef = Pick<TripRow, "id" | "date" | "plannedDeparture" | "originName" | "destName">;
type Detail = TripRow & {
  events: TripEventRow[];
  attachments: AttachmentRow[];
  claims: ClaimRow[];
  movedTo: (TripRef & { status: string }) | null;
  movedFromTrip: (TripRef & { expectedDelayMin: number | null }) | null;
};

const EVENT_LABEL: Record<string, string> = {
  control: "Kontrolliert",
  note: "Notiz",
  delay: "Verspätung",
  abort: "Abgebrochen",
  arrival: "Angekommen",
};
const CLAIM_STATUS: Record<string, string> = {
  draft: "Formular erstellt",
  submitted: "Eingereicht",
  paid: "Ausgezahlt",
  rejected: "Abgelehnt",
};

const timeOf = (ms: number) => new Date(ms).toLocaleTimeString("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" });
const dayLabel = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

const berlinIso = berlinToIso;
const deDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("de-DE");
const berlinDate = (iso: string) => berlinDay(iso);

export default function TripPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [t, setT] = React.useState<Detail | null>(null);
  const [msg, setMsg] = React.useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [dialog, setDialog] = React.useState<{ event: TripEventRow | null; type: "control" | "note" } | null>(null);

  const [loadError, setLoadError] = React.useState<string | null>(null);
  /** Trips of the same day — to tell which one of a double booking you'll take. */
  const [sameDay, setSameDay] = React.useState<TripRow[]>([]);
  const load = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/trips/${id}`);
      if (res.ok) {
        const trip = (await res.json()).trip as Detail;
        setT(trip);
        setLoadError(null);
        fetch(`/api/trips?from=${trip.date}&to=${trip.date}`)
          .then((r) => (r.ok ? r.json() : { trips: [] }))
          .then((d) => setSameDay(d.trips ?? []))
          .catch(() => {});
      } else setLoadError(res.status === 404 ? "Diese Fahrt gibt es nicht (mehr)." : `Laden fehlgeschlagen (${res.status}).`);
    } catch {
      setLoadError("Keine Verbindung – bitte später erneut versuchen.");
    }
  }, [id]);
  React.useEffect(() => {
    load();
    // The "today" banner (check, photo, "Wie geplant") changes this trip too.
    const onChange = () => load();
    window.addEventListener("trip-changed", onChange);
    return () => window.removeEventListener("trip-changed", onChange);
  }, [load]);

  // Lives here, not in WhatHappened: a save changes its key and remounts it.
  const [whSaved, setWhSaved] = React.useState(false);
  const flash = (m: string, ok = true) => {
    setMsg({ text: m, ok });
    setTimeout(() => setMsg(null), 4000);
  };
  async function patch(body: Record<string, unknown>): Promise<boolean> {
    try {
      const res = await fetch(`/api/trips/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) flash((await res.json().catch(() => ({}))).error ?? "Speichern fehlgeschlagen", false);
      await load();
      return res.ok;
    } catch {
      flash("Speichern fehlgeschlagen – keine Verbindung", false);
      return false;
    }
  }

  if (!t)
    return (
      <>
        <AppHeader />
        <main className="container py-10 text-center">
          {loadError ? (
            <div className="space-y-3">
              <p>{loadError}</p>
              <Link href="/reisen" className="text-primary underline">
                Zu meinen Reisen
              </Link>
            </div>
          ) : (
            <Spinner />
          )}
        </main>
      </>
    );

  const eventsByLeg = new Map<number, TripEventRow[]>();
  const loose: TripEventRow[] = [];
  for (const e of t.events) {
    if (e.legIndex != null && t.legs[e.legIndex]) eventsByLeg.set(e.legIndex, [...(eventsByLeg.get(e.legIndex) ?? []), e]);
    else loose.push(e);
  }
  const span = ticketSpan(t);
  // what the ticket covers per leg (from the span the booking names, "+City" = City-Ticket)
  const cover = tripTicketCover(t.legs, t.ticket);
  const tripDays = [t.date, ...(t.plannedArrival ? [berlinDay(t.plannedArrival)] : [])];
  const rtSum = realtimeSummary(t.legs);
  const delay = arrivalDelayMin(span.arrival, t.actualArrival);
  const ent = assess({
    status: t.status,
    price: t.price,
    plannedArrival: span.arrival,
    actualArrival: t.actualArrival,
    expectedDelayMin: t.expectedDelayMin,
    returnedToStart: t.returnedToStart,
    roundTrip: t.roundTrip,
    directionPrice: t.ticket?.directionPrice ?? null,
    replacement: !!t.movedFrom,
  });
  const plan = planStates(sameDay.some((x) => x.id === t.id) ? sameDay.map((x) => (x.id === t.id ? t : x)) : [...sameDay, t]).get(t.id);
  const rivals = sameDay.filter((x) => plan?.rivals.includes(x.id));
  const screenshots = t.attachments.filter((a) => !["claim", "ticket", "decision"].includes(a.kind));
  const tickets = t.attachments.filter((a) => a.kind === "ticket");
  const forms = t.attachments.filter((a) => a.kind === "claim" || a.kind === "decision");

  return (
    <>
      <AppHeader />
      <input
        ref={fileRef}
        type="file"
        accept="image/*,application/pdf"
        multiple
        className="hidden"
        onChange={async (e) => {
          if (!e.target.files?.length) return;
          setBusy("upload");
          try {
            const err = await uploadFiles(t.id, e.target.files);
            flash(err ?? "Gespeichert", !err);
          } catch {
            flash("Upload fehlgeschlagen – keine Verbindung", false);
          } finally {
            setBusy(null);
            e.target.value = "";
            load();
          }
        }}
      />
      <main className="container max-w-3xl space-y-4 py-5">
        <Link href={`/reisen?m=${t.date.slice(0, 7)}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground">
          <ArrowLeft className="h-4 w-4" /> Alle Reisen
        </Link>

        {/* Header — compact: day, status, route, times; the ticket folds out */}
        <Card className="p-3 sm:p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs text-muted-foreground">{dayLabel(t.date)}</div>
              <h1 className="text-base font-semibold leading-snug sm:text-lg">
                {t.originName} → {t.destName}
              </h1>
              <div className="tabular-nums text-sm">
                {t.plannedDeparture || t.plannedArrival ? (
                  `${formatTime(t.plannedDeparture)} – ${formatTime(t.plannedArrival)}`
                ) : (
                  <span className="text-muted-foreground">Uhrzeiten unbekannt{t.source === "claim" ? " (aus Fahrgastrechte-Antrag)" : ""}</span>
                )}
                {t.actualArrival && (
                  <span className={cn("ml-2 font-semibold", (delay ?? 0) >= 60 ? "text-danger" : (delay ?? 0) >= 20 ? "text-warning" : "text-success")}>
                    {span.to}: {formatTime(t.actualArrival)}
                    {delay != null && ` (${delay > 0 ? `+${delay}` : delay} min)`}
                  </span>
                )}
              </div>
            </div>
            <span className={cn("shrink-0 rounded-full px-2.5 py-1 text-xs font-medium", STATUS[t.status]?.cls)}>
              {STATUS[t.status]?.label ?? t.status}
            </span>
          </div>
          <MovedBanner t={t} />
          <PlanRow t={t} plan={plan} rivals={rivals} onSave={patch} />
          {t.ticket?.scheduleChange && (
            <div className="mt-2 rounded-xl border border-warning/40 bg-warning/10 p-2.5 text-sm">
              <b>Fahrplanänderung</b> (Mail vom {new Date(t.ticket.scheduleChange.notifiedAt).toLocaleDateString("de-DE")}):{" "}
              {t.ticket.scheduleChange.zugbindungLifted
                ? "Zugbindung aufgehoben – du darfst jeden Zug zu deinem Ziel nehmen, auch früher oder auf anderer Route."
                : "bitte die Verbindung prüfen."}
            </div>
          )}
          <TicketPanel t={t} tickets={tickets} cover={cover} onSave={patch} />
        </Card>

        <ForecastCard key={`${t.id}|${t.status}|${t.plan}`} t={t} />

        {/* Quick actions — one row even on a small phone */}
        <div className="grid grid-cols-3 gap-2">
          <Button variant="outline" size="sm" className="px-2" onClick={() => setDialog({ event: null, type: "control" })}>
            <ShieldCheck className="h-4 w-4 shrink-0" /> Kontrolle
          </Button>
          <Button variant="outline" size="sm" className="px-2" disabled={busy === "upload"} onClick={() => fileRef.current?.click()}>
            {busy === "upload" ? <Spinner /> : <Camera className="h-4 w-4 shrink-0" />} Beleg
          </Button>
          <Button variant="outline" size="sm" className="px-2" onClick={() => setDialog({ event: null, type: "note" })}>
            <StickyNote className="h-4 w-4 shrink-0" /> Notiz
          </Button>
        </div>
        {msg && <p className={cn("text-sm font-medium", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
        <EventDialog
          open={!!dialog}
          onClose={() => setDialog(null)}
          tripId={t.id}
          legs={t.legs}
          event={dialog?.event}
          initialType={dialog?.type}
          onSaved={() => {
            flash("Gespeichert");
            load();
            // the train position of a ticket check is looked up in the background
            setTimeout(load, 8000);
          }}
        />

        {/* Timeline with events — screenshots & receipts as a strip below */}
        <Card className="p-3 sm:p-4">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Verbindung</h2>
            <ActualsControl t={t} sum={rtSum} onLoaded={load} flash={flash} />
          </div>
          <div className="space-y-2 text-sm">
            {t.legs.map((l, i) => (
              <div key={i}>
                <div className="flex items-center gap-2">
                  <span className="w-12 shrink-0 tabular-nums font-semibold">{formatTime(l.plannedDeparture)}</span>
                  <span className="truncate">{l.fromName}</span>
                  {!l.isWalking && (
                    <RtMark planned={l.plannedDeparture} actual={l.rt?.dep} cancelled={l.rt?.depCancelled} later={l.rt?.dbLater?.dep} />
                  )}
                </div>
                <div className="ml-12 flex flex-wrap items-center gap-2 border-l-2 border-dashed border-border py-1 pl-3">
                  {l.isWalking ? (
                    <span className="text-xs text-muted-foreground">Fußweg</span>
                  ) : !l.product && !l.lineName ? (
                    <span className="text-xs text-muted-foreground">Züge unbekannt</span>
                  ) : (
                    <span className={cn("rounded px-2 py-0.5 text-xs font-semibold", legColor(l))}>{legLabel(l)}</span>
                  )}
                  {cover?.legs[i] === "out" && (
                    <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold text-warning" title="Dieser Abschnitt gehört nicht zum Ticket – eigener Fahrschein nötig">
                      nicht im Ticket
                    </span>
                  )}
                  {cover?.legs[i] === "city" && (
                    <span className="rounded bg-success/15 px-1.5 py-0.5 text-[10px] font-semibold text-success" title="Im City-Ticket enthalten (Nahverkehr in der Stadt)">
                      City-Ticket
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {l.depPlatform ? `Gl. ${l.depPlatform} ` : ""}→ {l.toName} an {formatTime(l.plannedArrival)}
                    {l.arrPlatform ? ` · Gl. ${l.arrPlatform}` : ""}
                  </span>
                  {!l.isWalking && l.rt?.arr && (
                    <RtMark planned={l.plannedArrival} actual={l.rt.arr} cancelled={l.rt.arrCancelled} prefix="an" later={l.rt.dbLater?.arr} />
                  )}
                  {!!l.rtLog?.length && <LiveLog leg={l} />}
                  {l.reservation && <span className="text-xs font-medium text-primary">Platz: {l.reservation}</span>}
                </div>
                {(eventsByLeg.get(i) ?? []).map((e) => (
                  <EventLine key={e.id} e={e} tripId={t.id} tripDays={tripDays} onDeleted={load} onEdit={() => setDialog({ event: e, type: e.type === "note" ? "note" : "control" })} />
                ))}
                {rtSum?.missed
                  .filter((m) => m.afterLeg === i)
                  .map((m) => (
                    <p key={m.nextLeg} className="ml-12 border-l-2 border-dashed border-border py-1 pl-3 text-xs font-medium text-danger">
                      Anschluss in {m.station} verpasst: an {formatTime(m.arrived)}, {legLabel(t.legs[m.nextLeg])} fuhr{" "}
                      {formatTime(m.departed)}
                    </p>
                  ))}
              </div>
            ))}
            <div className="flex items-center gap-2">
              <span className="w-12 shrink-0 tabular-nums font-semibold">{formatTime(t.plannedArrival)}</span>
              <span className="font-semibold">{t.destName}</span>
            </div>
            {loose.map((e) => (
              <EventLine key={e.id} e={e} tripId={t.id} tripDays={tripDays} onDeleted={load} onEdit={() => setDialog({ event: e, type: e.type === "note" ? "note" : "control" })} />
            ))}
          </div>
          {screenshots.length > 0 && (
            <div className="mt-3 border-t border-border pt-2">
              <div className="mb-1 text-xs text-muted-foreground">Screenshots & Belege ({screenshots.length})</div>
              <div className="flex gap-2 overflow-x-auto pb-1">
              {screenshots.map((a) => (
                <div key={a.id} className="group relative w-20 shrink-0 overflow-hidden rounded-lg border border-border">
                  <a href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer">
                    {a.mime.startsWith("image/") && a.mime !== "image/heic" && a.mime !== "image/heif" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={`/api/attachments/${a.id}`} alt={a.filename} className="aspect-[3/4] w-full object-cover" loading="lazy" />
                    ) : (
                      <div className="flex aspect-[3/4] flex-col items-center justify-center gap-1 p-2 text-center text-xs text-muted-foreground">
                        <FileText className="h-6 w-6" />
                        <span className="line-clamp-2 break-all">{a.filename}</span>
                      </div>
                    )}
                  </a>
                  <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-black/50 px-1.5 py-0.5 text-[10px] text-white">
                    <span>{timeOf(a.createdAt)}</span>
                    <button
                      onClick={async () => {
                        if (!confirm("Datei löschen?")) return;
                        await fetch(`/api/attachments/${a.id}`, { method: "DELETE" });
                        load();
                      }}
                      aria-label="Datei löschen"
                      className="-m-1 p-1.5"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
              </div>
            </div>
          )}
        </Card>

        {/* What happened + passenger rights in one card; folds when settled */}
        <OutcomeCard t={t} ent={ent}>
          <WhatHappened
            key={`${t.status}|${t.actualArrival}|${t.abortedAt}|${t.expectedDelayMin}|${t.returnedToStart}|${t.notes}`}
            t={t}
            saved={whSaved}
            shots={screenshots.length}
            onMoved={(m) => {
              flash(m);
              load();
            }}
            onSave={async (b) => {
              const ok = await patch(b);
              if (ok) {
                setWhSaved(true);
                setTimeout(() => setWhSaved(false), 2000);
              }
              return ok;
            }}
          />
          <div className="mt-4 border-t border-border pt-3">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Fahrgastrechte</h3>
          {t.status === "lifted" ? (
            <div className="space-y-1 text-sm">
              <span className="font-semibold">Ticket offen – Zugbindung aufgehoben</span>
              <p className="text-muted-foreground">
                Nutzbar laut DB bis {deDay(liftedUsableUntil(t.date))}. Fährst du damit, oben „Damit gefahren …“ – dort zählt dann eine neue
                Verspätung. Erstattung gibt es nur bei mind. 60 min angekündigter Verspätung
                {t.expectedDelayMin != null ? ` (eingetragen: ${t.expectedDelayMin} min)` : ""}.
              </p>
            </div>
          ) : t.status === "moved" ? (
              <div className="space-y-2 text-sm">
                <span className="font-semibold">Ticket an einem anderen Tag genutzt</span>
                {movedNotes(t.expectedDelayMin).notes.map((n) => (
                  <p key={n} className="text-muted-foreground">
                    {n}
                  </p>
                ))}
                {movedNotes(t.expectedDelayMin).warnings.map((n) => (
                  <p key={n} className="text-xs text-warning">
                    {n}
                  </p>
                ))}
              </div>
            ) : ent ? (
              <ClaimBox t={t} ent={ent} onDone={load} />
            ) : (
              <p className="text-sm text-muted-foreground">
                {t.status === "planned"
                  ? "Nach der Fahrt oben eintragen, was passiert ist – dann rechnet die App aus, was dir zusteht."
                  : (t.status === "delayed" || t.status === "done") && !t.actualArrival
                    ? "Trag oben die tatsächliche Ankunft ein – dann rechnet die App aus, ob dir etwas zusteht."
                    : !span.arrival && t.actualArrival
                      ? "Die geplante Ankunft ist unbekannt – ohne sie lässt sich die Verspätung nicht berechnen."
                      : "Laut den DB-Regeln besteht kein Anspruch (Entschädigung erst ab 60 min Verspätung am Ziel)."}
                {t.status === "planned" && liveHints(t.expectedDelayMin).length > 0 && (
                  <span className="mt-1 block">{liveHints(t.expectedDelayMin)[0]}</span>
                )}
              </p>
            )}
            <OnlineClaim t={t} onDone={load} flash={flash} />
            {t.claims.length > 0 && (
              <div className="mt-3 space-y-2 border-t border-border pt-3">
                {t.claims.map((c) => (
                  <ClaimLine key={c.id} c={c} tripId={t.id} onSaved={load} />
                ))}
              </div>
            )}
            {forms.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {forms.map((a) => (
                  <a key={a.id} href={`/api/attachments/${a.id}?download`} className="inline-flex items-center gap-1 text-sm text-primary underline">
                    <FileDown className="h-4 w-4" /> {a.filename}
                  </a>
                ))}
              </div>
            )}
          </div>
        </OutcomeCard>

        <div className="flex justify-end">
          <Button
            variant="ghost"
            className="text-danger"
            onClick={async () => {
              if (!confirm("Fahrt mit allen Belegen löschen?")) return;
              await fetch(`/api/trips/${t.id}`, { method: "DELETE" });
              router.push(`/reisen?m=${t.date.slice(0, 7)}`);
            }}
          >
            <Trash2 className="h-4 w-4" /> Fahrt löschen
          </Button>
        </div>
      </main>
    </>
  );
}

/** Actual time next to a planned one: "+12" / "pünktlich" / "fällt aus". */
function RtMark({
  planned,
  actual,
  cancelled,
  prefix,
  later,
}: {
  planned: string | null;
  actual?: string | null;
  cancelled?: boolean;
  prefix?: string;
  /** DB's data says something else now than what we saw live. */
  later?: string | null;
}) {
  if (cancelled) return <span className="shrink-0 text-xs font-semibold text-danger">fällt aus</span>;
  const d = delayMin(planned, actual);
  if (d == null) return null;
  return (
    <span
      className={cn(
        "shrink-0 text-xs tabular-nums",
        d >= 20 ? "font-semibold text-danger" : d >= 5 ? "font-medium text-warning" : "text-success",
      )}
      title={`Tatsächlich ${formatTime(actual!)}`}
    >
      {prefix ? `${prefix} ` : ""}
      {formatTime(actual!)}
      {d !== 0 ? ` (${d > 0 ? "+" : ""}${d})` : ""}
      {later && (
        <span className="font-normal text-muted-foreground" title="Von uns live gemessen – die DB-Daten wurden nachträglich geändert">
          {" "}
          · DB jetzt {formatTime(later)}
        </span>
      )}
    </span>
  );
}

/** Every live observation of one train (forecasts included) — kept as evidence. */
function LiveLog({ leg }: { leg: Detail["legs"][number] }) {
  const log = leg.rtLog ?? [];
  const fmt = (planned: string | null, v: string | null | undefined, cancelled?: boolean) => {
    if (cancelled) return "fällt aus";
    const d = delayMin(planned, v);
    return v ? `${formatTime(v)}${d ? ` (${d > 0 ? "+" : ""}${d})` : ""}` : "–";
  };
  return (
    <details className="w-full text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">Live-Verlauf ({log.length} Messungen)</summary>
      <ul className="mt-1 space-y-0.5 tabular-nums">
        {log.map((o) => (
          <li key={o.at}>
            {new Date(o.at).toLocaleTimeString("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" })}: ab{" "}
            {fmt(leg.plannedDeparture, o.dep, o.depCancelled)} · an {fmt(leg.plannedArrival, o.arr, o.arrCancelled)}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Source of the actual times / button to load them for a past trip. */
function ActualsControl({
  t,
  sum,
  onLoaded,
  flash,
}: {
  t: Detail;
  sum: RealtimeSummary | null;
  onLoaded: () => void;
  flash: (m: string, ok?: boolean) => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const today = todayLocal();
  const past = t.date < today;
  const rail = t.legs.filter((l) => !l.isWalking && l.product);
  const open = (past || t.date === today) && rail.some((l) => !(l.rt?.source === "opendata" && l.rt.final));
  const live = rail.some((l) => l.rt?.source === "live") && !past;
  if (!open && !sum) return null;
  return (
    <span className="flex items-center gap-2 text-xs text-muted-foreground">
      {sum && (
        <span title="Quelle: offene Daten der DB-Fahrplanschnittstelle (piebro/deutsche-bahn-data)">
          {live ? "Live-Daten der DB" : `Ist-Zeiten laut DB${sum.final ? "" : " (vorläufig)"}`}
        </span>
      )}
      {open && (
        <button
          className="inline-flex items-center gap-1 text-primary underline disabled:opacity-50"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const res = await fetch(`/api/trips/${t.id}/actuals`, { method: "POST" });
              const d = await res.json().catch(() => ({}));
              if (!res.ok) flash(d.error ?? "Ist-Zeiten konnten nicht geladen werden", false);
              else flash("Ist-Zeiten geladen");
              onLoaded();
            } catch {
              flash("Ist-Zeiten konnten nicht geladen werden – keine Verbindung", false);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy && <Spinner className="h-3 w-3" />}
          {busy ? "lädt (bis zu 1 Min.) …" : sum ? "aktualisieren" : past ? "Ist-Zeiten laden" : "Live-Daten laden"}
        </button>
      )}
    </span>
  );
}

const signed = (n: number | null) => (n == null ? "" : n > 0 ? `+${n}` : n < 0 ? `${n}` : "pünktlich");

/** Where the train was at a ticket check (live DB data at that moment). */
function ControlContext({ c }: { c: NonNullable<TripEventRow["context"]> }) {
  const where =
    c.where === "between"
      ? `zwischen ${c.from} und ${c.to}`
      : c.where === "at"
        ? `Halt in ${c.from}`
        : c.where === "before"
          ? `vor der Abfahrt in ${c.from}`
          : c.where === "after"
            ? `nach der Ankunft in ${c.from}`
            : null;
  const delay = c.delayMin != null ? `Zug ${signed(c.delayMin)}${c.delayMin !== 0 ? " min" : ""}` : null;
  const next = c.where === "between" && c.nextDelayMin != null ? `an ${c.to} ${signed(c.nextDelayMin)}${c.nextDelayMin ? " min" : ""}` : null;
  return (
    <p className="text-muted-foreground">
      {[c.train, where, delay, next].filter(Boolean).join(" · ")}
      {c.note && ` ${c.note}`}
      {c.outsideLeg && <span className="font-medium text-warning"> · außerhalb deines gebuchten Abschnitts</span>}
      {c.gpsOk === true && <span className="text-success"> · Standort passt zum Zug</span>}
      {c.gpsOk === false && (
        <span className="font-medium text-warning"> · Standort {c.gpsKm} km von der Strecke – anderer Zug?</span>
      )}
    </p>
  );
}

function EventLine({
  e,
  tripId,
  tripDays,
  onDeleted,
  onEdit,
}: {
  e: TripEventRow;
  tripId: string;
  /** Berlin days the trip runs on – other days get a date in front of the time. */
  tripDays: string[];
  onDeleted: () => void;
  onEdit: () => void;
}) {
  const day = berlinDay(e.at);
  const when = tripDays.includes(day) ? timeOf(e.at) : `${Number(day.slice(8))}.${Number(day.slice(5, 7))}. ${timeOf(e.at)}`;
  // long entries (e.g. a saved forecast) fold to three lines — tap shows all
  const [full, setFull] = React.useState(false);
  return (
    <div className="ml-12 flex items-start gap-2 border-l-2 border-dashed border-border py-0.5 pl-3 text-xs">
      {e.type === "control" ? (
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
      ) : (
        <StickyNote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1 break-words">
        <p className={cn(!full && "line-clamp-3")} onClick={() => setFull((f) => !f)}>
          <span className="tabular-nums font-medium">{when}</span> {EVENT_LABEL[e.type] ?? e.type}
          {e.text && <span className="text-muted-foreground"> – {e.text}</span>}
        </p>
        {e.context && <ControlContext c={e.context} />}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {e.lat != null && e.lng != null ? (
          <a
            href={mapsLink(e.lat, e.lng)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 text-primary"
            title={e.accuracy ? `GPS ± ${Math.round(e.accuracy)} m` : "von Hand gesetzt"}
          >
            <MapPin className="h-3 w-3" /> Ort
          </a>
        ) : (
          e.type === "control" && (
            <button className="whitespace-nowrap text-primary underline" onClick={onEdit}>
              Ort setzen
            </button>
          )
        )}
        <button className="p-0.5 text-muted-foreground" onClick={onEdit} aria-label="Bearbeiten">
          <Pencil className="h-3 w-3" />
        </button>
        <button
          className="p-0.5 text-muted-foreground"
          onClick={async () => {
            if (!confirm("Eintrag löschen?")) return;
            await fetch(`/api/trips/${tripId}/events?eventId=${e.id}`, { method: "DELETE" });
            onDeleted();
          }}
          aria-label="Löschen"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

function TicketFields({ t, onSave }: { t: Detail; onSave: (b: Record<string, unknown>) => Promise<boolean> }) {
  const [open, setOpen] = React.useState(false);
  const fromTrip = () => ({
    price: t.price != null ? String(t.price).replace(".", ",") : "",
    orderNumber: t.orderNumber ?? "",
    ticketType: t.ticketType ?? "",
    direction: t.direction ?? "outbound",
    roundTrip: t.roundTrip,
    directionPrice: t.ticket?.directionPrice != null ? String(t.ticket.directionPrice).replace(".", ",") : "",
  });
  const [f, setF] = React.useState(fromTrip);
  if (!open)
    return (
      <div className="pt-1">
        <button
          className="text-primary underline"
          onClick={() => {
            setF(fromTrip()); // start from what is stored, not from an abandoned edit
            setOpen(true);
          }}
        >
          Ticketdaten bearbeiten
        </button>
      </div>
    );
  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      <Input placeholder="Preis €" inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />
      <Input placeholder="Auftragsnummer" value={f.orderNumber} onChange={(e) => setF({ ...f, orderNumber: e.target.value })} />
      <Input placeholder="Ticket (z. B. Sparpreis)" value={f.ticketType} onChange={(e) => setF({ ...f, ticketType: e.target.value })} />
      <select
        className="h-10 rounded-xl border border-input bg-background px-3"
        value={f.direction}
        onChange={(e) => setF({ ...f, direction: e.target.value })}
      >
        <option value="outbound">Hinfahrt</option>
        <option value="return">Rückfahrt</option>
      </select>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" checked={f.roundTrip} onChange={(e) => setF({ ...f, roundTrip: e.target.checked })} />
        Preis gilt für Hin- und Rückfahrt zusammen
      </label>
      {f.roundTrip && (
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          <span className="text-xs text-muted-foreground">
            Preis dieser Richtung (steht in „Meine Reisen“ auf bahn.de) – sonst rechnet die App mit dem halben Preis
          </span>
          <Input
            placeholder="z. B. 20,99"
            inputMode="decimal"
            value={f.directionPrice}
            onChange={(e) => setF({ ...f, directionPrice: e.target.value })}
          />
        </label>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <Button
          size="sm"
          onClick={async () => {
            const price = f.price.trim() ? Number(f.price.replace(",", ".")) : null;
            const dir = f.roundTrip && f.directionPrice.trim() ? Number(f.directionPrice.replace(",", ".")) : null;
            const ok = await onSave({
              price: price != null && Number.isFinite(price) ? price : null,
              directionPrice: dir != null && Number.isFinite(dir) ? dir : null,
              orderNumber: f.orderNumber.trim() || null,
              ticketType: f.ticketType.trim() || null,
              direction: f.direction,
              roundTrip: f.roundTrip,
            });
            if (ok) setOpen(false);
          }}
        >
          Speichern
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Abbrechen
        </Button>
      </div>
    </div>
  );
}

/** Status + what actually happened (actual arrival, abort station, expected delay, free text). */
function WhatHappened({
  t,
  saved,
  onSave,
  onMoved,
  shots,
}: {
  t: Detail;
  saved: boolean;
  onSave: (b: Record<string, unknown>) => Promise<boolean>;
  onMoved: (msg: string) => void;
  /** screenshots / evidence uploaded for the trip */
  shots: number;
}) {
  const span = ticketSpan(t);
  const rt = realtimeSummary(t.legs);
  const stations = Array.from(new Set(t.legs.flatMap((l) => [l.fromName, l.toName])));
  const [status, setStatus] = React.useState(t.status);
  const [arrDate, setArrDate] = React.useState(t.actualArrival ? berlinDate(t.actualArrival) : span.arrival ? berlinDate(span.arrival) : t.date);
  const [arrTime, setArrTime] = React.useState(t.actualArrival ? formatTime(t.actualArrival) : "");
  const [abortedAt, setAbortedAt] = React.useState(t.abortedAt ?? t.originName);
  const [returned, setReturned] = React.useState(t.returnedToStart);
  const [expected, setExpected] = React.useState(t.expectedDelayMin != null ? String(t.expectedDelayMin) : "");
  const [notes, setNotes] = React.useState(t.notes ?? "");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  // "Später gefahren": on which day, and with which journey (existing trip or the same trains)
  const nextDay = new Date(Date.parse(`${t.date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const [moveDate, setMoveDate] = React.useState(t.movedTo?.date ?? nextDay);
  const [moveTarget, setMoveTarget] = React.useState<string>("");
  const [dayTrips, setDayTrips] = React.useState<TripRow[]>([]);
  React.useEffect(() => {
    if (status !== "moved" || t.status === "moved" || !/^\d{4}-\d{2}-\d{2}$/.test(moveDate)) return;
    fetch(`/api/trips?from=${moveDate}&to=${moveDate}`)
      .then((r) => (r.ok ? r.json() : { trips: [] }))
      .then((d) => setDayTrips(((d.trips ?? []) as TripRow[]).filter((x) => x.id !== t.id && !x.movedFrom)))
      .catch(() => setDayTrips([]));
    setMoveTarget("");
  }, [status, moveDate, t.id, t.status]);

  const groups: [string, [string, string][]][] = [
    [
      "Gefahren",
      [
        ["done", "Pünktlich"],
        ["delayed", "Verspätet"],
        ["aborted", "Abgebrochen"],
      ],
    ],
    [
      "Nicht gefahren",
      [
        ["lifted", "Zugbindung aufgehoben – Ticket offen"],
        ["moved", "Mit dem Ticket später gefahren"],
        ["not_started", "Erstattung (nicht angetreten)"],
        ["cancelled", "Zugausfall"],
      ],
    ],
  ];
  const needsArrival = status === "delayed" || status === "done";
  const needsExpected = status === "aborted" || status === "not_started" || status === "moved" || status === "lifted";
  const exp = expected ? Number(expected) : null;
  const hint =
    status === "lifted"
      ? `Ab 20 min angekündigter Verspätung am Ziel darfst du das Ticket für eine andere Fahrt nutzen – laut DB bis ${deDay(liftedUsableUntil(t.date))}. Screenshot der Prognose aufheben${shots ? ` (${shots} hochgeladen ✓)` : ""}. Entscheiden kannst du später: damit fahren oder Erstattung (nur ab 60 min).`
      : status === "cancelled"
      ? "Nur wählen, wenn du die Reise deshalb nicht angetreten hast. Mit dem Ticket an einem anderen Tag gefahren: „Mit dem Ticket später gefahren“."
      : status === "moved" && t.status !== "moved"
        ? "Ab 20 min angekündigter Verspätung darfst du mit dem Ticket später fahren, laut DB auch an einem anderen Tag. Die Fahrt, die du dann machst, wird als eigene Fahrt eingetragen – dort zählt eine neue Verspätung."
      : status === "delayed" && !arrTime
        ? "Trag die tatsächliche Ankunft ein – erst dann lässt sich die Entschädigung berechnen."
        : null;

  return (
    <div>
      <div className="space-y-2">
        {groups.map(([group, opts]) => (
          <div key={group} className="flex flex-wrap items-center gap-1.5">
            <span className="w-full text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{group}</span>
            {opts
              // a replacement journey can't be moved on again
              .filter(([k]) => !(k === "moved" && t.movedFrom))
              .map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setStatus(k)}
                  aria-pressed={status === k}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs",
                    status === k ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted",
                  )}
                >
                  {label}
                </button>
              ))}
          </div>
        ))}
      </div>
      {hint && <p className="mt-2 text-xs text-muted-foreground">{hint}</p>}
      {status === "lifted" && exp != null && exp < 20 && (
        <p className="mt-1 text-xs text-warning">Unter 20 min angekündigter Verspätung gilt die Zugbindung noch.</p>
      )}
      {/* open ticket: the two ways on */}
      {t.status === "lifted" && status === "lifted" && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" onClick={() => setStatus("moved")}>
            Damit gefahren …
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={(t.expectedDelayMin ?? 0) < 60}
            title={(t.expectedDelayMin ?? 0) < 60 ? "Erstattung erst ab 60 min angekündigter Verspätung" : undefined}
            onClick={() => setStatus("not_started")}
          >
            Erstattung beantragen
          </Button>
        </div>
      )}
      {rt?.arrival ? (
        <p className="mt-2 text-xs">
          Laut DB-Daten: an {span.to} {formatTime(rt.arrival)}
          {rt.arrivalDelay ? ` (${rt.arrivalDelay > 0 ? "+" : ""}${rt.arrivalDelay} min)` : " (pünktlich)"}
          {!rt.final && " – vorläufig"}.{" "}
          <button
            type="button"
            className="font-medium text-primary underline"
            onClick={() => {
              setArrDate(berlinDate(rt.arrival!));
              setArrTime(formatTime(rt.arrival!));
              setStatus((rt.arrivalDelay ?? 0) > 0 ? "delayed" : "done");
            }}
          >
            Übernehmen
          </button>
        </p>
      ) : rt?.missed.length ? (
        <p className="mt-2 text-xs">
          Laut DB-Daten ist dein Anschluss in {rt.missed[0].station} geplatzt – trag ein, wann du wirklich angekommen bist, ob
          du abgebrochen hast oder gar nicht gefahren bist.
        </p>
      ) : rt?.cancelled.length ? (
        <p className="mt-2 text-xs">Laut DB-Daten ist ein Zug deiner Verbindung ausgefallen.</p>
      ) : null}
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 [&>*]:min-w-0">
        {needsArrival && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">
              Tatsächliche Ankunft in {span.to} (planmäßig {formatTime(span.arrival)})
            </span>
            <div className="flex gap-2">
              <Input type="date" value={arrDate} onChange={(e) => setArrDate(e.target.value)} />
              <Input type="time" value={arrTime} onChange={(e) => setArrTime(e.target.value)} />
            </div>
          </label>
        )}
        {status === "aborted" && (
          <div className="flex flex-col gap-1 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Abgebrochen in</span>
              <select
                className="h-10 w-full min-w-0 max-w-full truncate rounded-xl border border-input bg-background px-3"
                value={abortedAt}
                onChange={(e) => setAbortedAt(e.target.value)}
              >
                {stations.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 py-1">
              <input type="checkbox" checked={returned} onChange={(e) => setReturned(e.target.checked)} /> zurück zum Startbahnhof gefahren
            </label>
          </div>
        )}
        {needsExpected && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">Angekündigte Verspätung am Ziel (min)</span>
            <Input inputMode="numeric" placeholder="z. B. 75" value={expected} onChange={(e) => setExpected(e.target.value.replace(/\D/g, ""))} />
          </label>
        )}
        {status === "moved" && t.status !== "moved" && (
          <div className="flex flex-col gap-2 text-sm sm:col-span-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Gefahren am</span>
              <Input type="date" value={moveDate} min={t.date} onChange={(e) => setMoveDate(e.target.value)} />
            </label>
            <div className="space-y-1">
              <label className="flex items-start gap-2">
                <input type="radio" className="mt-1" checked={moveTarget === ""} onChange={() => setMoveTarget("")} />
                <span>
                  Mit denselben Zügen ({formatTime(t.plannedDeparture)} ab {t.originName}) – als neue Fahrt anlegen
                </span>
              </label>
              {dayTrips.map((x) => (
                <label key={x.id} className="flex items-start gap-2">
                  <input type="radio" className="mt-1" checked={moveTarget === x.id} onChange={() => setMoveTarget(x.id)} />
                  <span>
                    Schon eingetragen: {formatTime(x.plannedDeparture)} {x.originName} → {x.destName}
                  </span>
                </label>
              ))}
              <p className="text-xs text-muted-foreground">
                Andere Verbindung? Erst in der Suche bei der Verbindung „Gebucht“ tippen, dann taucht sie hier zur Auswahl auf.
              </p>
            </div>
          </div>
        )}
        {t.status === "moved" && status === "moved" && t.movedTo && (
          <p className="text-sm sm:col-span-2">
            Gefahren am{" "}
            <Link href={`/reisen/${t.movedTo.id}`} className="font-medium text-primary underline">
              {dayLabel(t.movedTo.date)}, {formatTime(t.movedTo.plannedDeparture)}
            </Link>
            .
          </p>
        )}
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          <span className="text-xs text-muted-foreground">So bin ich tatsächlich gefahren / Bemerkungen</span>
          <textarea
            className="min-h-[80px] rounded-xl border border-input bg-background p-3 text-sm"
            placeholder="z. B. Anschluss in Köln verpasst, mit RE 10:56 weiter, Taxi ab St. Georgen"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
      </div>
      <Button
        className="mt-3"
        disabled={busy}
        onClick={async () => {
          let iso = needsArrival && arrTime ? berlinIso(arrDate, arrTime) : null;
          // 01:15 entered for a 23:30 arrival without changing the date → next day.
          if (iso && span.arrival && new Date(iso).getTime() < new Date(span.arrival).getTime() - 6 * 3600_000)
            iso = new Date(new Date(iso).getTime() + 86_400_000).toISOString();
          setBusy(true);
          setErr(null);
          const move = async (method: "POST" | "DELETE", body?: unknown) => {
            const res = await fetch(`/api/trips/${t.id}/move`, {
              method,
              headers: { "Content-Type": "application/json" },
              body: body ? JSON.stringify(body) : undefined,
            }).catch(() => null);
            if (!res?.ok) setErr((await res?.json().catch(() => ({})))?.error ?? "Keine Verbindung");
            return !!res?.ok;
          };
          // Leaving "moved": unlink (and remove the copied replacement) first.
          if (t.status === "moved" && status !== "moved") {
            if (!confirm("Ersatzfahrt-Verknüpfung aufheben? Eine automatisch angelegte, unveränderte Ersatzfahrt wird gelöscht.")) {
              setBusy(false);
              return;
            }
            if (!(await move("DELETE"))) return setBusy(false);
          }
          const ok = await onSave({
            ...(status === "moved" ? {} : { status }),
            actualArrival: needsArrival ? iso : null,
            abortedAt: status === "aborted" ? abortedAt : null,
            returnedToStart: status === "aborted" ? returned : false,
            expectedDelayMin: needsExpected && expected ? Number(expected) : null,
            notes: notes.trim() || null,
          });
          if (ok && status === "moved" && t.status !== "moved" && (await move("POST", { date: moveDate, targetId: moveTarget || null })))
            onMoved("Ersatzfahrt eingetragen");
          setBusy(false);
        }}
      >
        {busy ? <Spinner /> : saved ? "Gespeichert ✓" : "Speichern"}
      </Button>
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
    </div>
  );
}

/** The ticket in one line (tariff · price · class); tap → details, PDF, edit. */
function TicketPanel({
  t,
  tickets,
  cover,
  onSave,
}: {
  t: Detail;
  tickets: AttachmentRow[];
  cover: TripCover | null;
  onSave: (b: Record<string, unknown>) => Promise<boolean>;
}) {
  const outside = cover ? t.legs.filter((_, i) => cover.legs[i] === "out") : [];
  const [open, setOpen] = React.useState(false);
  // round-trip tickets list both directions — show this day's trains
  const day = t.date.split("-").reverse().join(".");
  const zb = t.ticket?.zugbindung ?? [];
  const zbList = (zb.filter((z) => z.includes(day)).length ? zb.filter((z) => z.includes(day)) : zb).map((z) => z.split(",")[0]);
  const summary = [
    t.ticket?.tariff ?? t.ticketType ?? "Ticket",
    t.price != null ? formatEuro(t.price) : "Preis fehlt",
    t.klasse ? `${t.klasse}. Kl.` : null,
    t.ticket?.bahncard ?? null,
    t.roundTrip ? "Hin+Rück" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="mt-2 border-t border-border pt-2 text-sm">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 text-left" aria-expanded={open}>
        <span className="min-w-0 flex-1 truncate">🎫 {summary}</span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {cover ? (
        <div className="mt-0.5 text-xs text-muted-foreground">
          Gilt {cover.from}
          {cover.cityFrom && <span className="text-success"> + City-Ticket</span>} → {cover.to}
          {cover.cityTo && <span className="text-success"> + City-Ticket</span>}
        </div>
      ) : (
        t.ticket?.from &&
        t.ticket.to && (
          <div className="mt-0.5 text-xs text-muted-foreground">
            Gilt {t.ticket.from} → {t.ticket.to}
          </div>
        )
      )}
      {outside.length > 0 && (
        <div className="mt-0.5 text-xs font-medium text-warning">
          ⚠ Nicht im Ticket: {outside.map((l) => `${legLabel(l)} ${l.fromName} → ${l.toName}`).join(" · ")}
        </div>
      )}
      {open && (
        <div className="mt-2 space-y-1 text-xs text-muted-foreground">
          {t.orderNumber && <div>Auftrag {t.orderNumber}</div>}
          {t.roundTrip && t.ticket?.directionPrice != null && <div>diese Richtung {formatEuro(t.ticket.directionPrice)}</div>}
          {zbList.length > 0 && <div>Zugbindung: {zbList.join(", ")}</div>}
          {t.ticket?.validity && <div>Gültig {t.ticket.validity}</div>}
          {t.ticket?.reservationOnly && (
            <div>
              Nur Sitzplatzreservierung{t.ticket.reservationPrice != null ? ` (${formatEuro(t.ticket.reservationPrice)})` : ""} – der Fahrschein war
              separat. Für Fahrgastrechte zählt der Preis des Fahrscheins.
            </div>
          )}
          {tickets.map((a) => (
            <a key={a.id} href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer" className="mr-3 inline-flex items-center gap-1 text-primary underline">
              <FileText className="h-3.5 w-3.5" /> Ticket öffnen
            </a>
          ))}
          <TicketFields t={t} onSave={onSave} />
        </div>
      )}
    </div>
  );
}

/**
 * "Was ist passiert?" and the passenger rights in one card. Folded (one line)
 * when there is nothing to do: still to come, or settled (claim sent / nothing due).
 */
function OutcomeCard({ t, ent, children }: { t: Detail; ent: ReturnType<typeof assess>; children: React.ReactNode }) {
  const past = !!t.plannedDeparture && new Date(t.plannedDeparture).getTime() < Date.now();
  const sent = t.claims.some((c) => c.status === "submitted" || c.status === "paid" || c.status === "rejected");
  const settled = sent || (t.status !== "planned" && t.status !== "lifted" && !ent?.payable);
  const summary =
    t.status === "planned"
      ? past
        ? "Noch offen – eintragen, wie es lief"
        : "Nach der Fahrt eintragen, was passiert ist"
      : [
          STATUS[t.status]?.label ?? t.status,
          sent
            ? `Antrag ${t.claims.find((c) => c.status === "paid") ? "ausgezahlt" : t.claims.find((c) => c.status === "rejected") ? "abgelehnt" : "eingereicht"}`
            : ent?.payable && ent.amount != null
              ? `${formatEuro(ent.amount)} möglich`
              : null,
        ]
          .filter(Boolean)
          .join(" · ");
  const [open, setOpen] = React.useState(() => !(settled || (t.status === "planned" && !past)));
  return (
    <Card className="p-3 sm:p-4">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 text-left" aria-expanded={open}>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold uppercase tracking-wide text-muted-foreground">Was ist passiert?</span>
          {!open && <span className="block truncate text-xs text-muted-foreground">{summary}</span>}
        </span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && <div className="mt-3">{children}</div>}
    </Card>
  );
}

/** The two ends of "ticket used another day": the booked trip ↔ the journey made. */
function MovedBanner({ t }: { t: Detail }) {
  const ref = t.status === "moved" ? t.movedTo : t.movedFromTrip;
  if (!ref) return null;
  return (
    <div className="mt-3 rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm">
      {t.status === "moved" ? "🔁 Nicht gefahren – mit diesem Ticket gefahren am " : "🔁 Ersatzfahrt mit dem Ticket der Fahrt vom "}
      <Link href={`/reisen/${ref.id}`} className="font-medium text-primary underline">
        {dayLabel(ref.date)}, {formatTime(ref.plannedDeparture)}
      </Link>
      {t.movedFromTrip?.expectedDelayMin != null && ` (damals angekündigt: +${t.movedFromTrip.expectedDelayMin} min)`}
    </div>
  );
}

/** "Nehme ich wahr?" — for upcoming trips, above all when a day has two bookings. */
function PlanRow({
  t,
  plan,
  rivals,
  onSave,
}: {
  t: Detail;
  plan: PlanInfo | undefined;
  rivals: TripRow[];
  onSave: (b: Record<string, unknown>) => Promise<boolean>;
}) {
  const mine = t.plan === "take" || t.plan === "skip" ? t.plan : null;
  // only when two bookings really overlap (or a mark was set) — otherwise nothing to decide
  if (t.status !== "planned" || (!rivals.length && !mine)) return null;
  const btn = (value: "take" | "skip", label: string) => (
    <button
      type="button"
      aria-pressed={mine === value}
      onClick={() => onSave({ plan: mine === value ? null : value })}
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs",
        mine === value
          ? value === "take"
            ? "border-success bg-success text-white"
            : "border-muted-foreground bg-muted-foreground text-background"
          : "border-border hover:bg-muted",
      )}
    >
      {label}
    </button>
  );
  return (
    <div className={cn("mt-2 rounded-xl p-2 text-xs", plan?.state === "open" ? "bg-warning/10" : "bg-muted/40")}>
      {rivals.length > 0 && (
        <div className="mb-1.5 text-muted-foreground">
          {plan?.state === "open" ? <b className="text-warning">Doppelt gebucht</b> : "Überschneidet sich"} mit{" "}
          {rivals.map((r, i) => (
            <React.Fragment key={r.id}>
              {i > 0 && ", "}
              <Link href={`/reisen/${r.id}`} className="text-primary underline">
                {formatTime(r.plannedDeparture)} → {r.destName}
              </Link>
              {r.plan === "take" ? " (nehme ich)" : r.plan === "skip" || r.status === "moved" || r.status === "lifted" ? " (nicht)" : ""}
            </React.Fragment>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {btn("take", "✓ Nehme ich")}
        {btn("skip", "✗ Nehme ich nicht")}
        {plan?.implied && plan.state === "skip" && !mine && <span className="text-muted-foreground">– du nimmst die andere</span>}
      </div>
    </div>
  );
}

const ONLINE_LABEL: Record<OnlineClaimType, string> = {
  verspaetung: "Verspätung am Ziel",
  "nicht-angetreten": "Reise nicht angetreten",
  abgebrochen: "Fahrt unterwegs abgebrochen",
};

/** Submit through the DB customer account — shows exactly what goes out, sends only after confirmation. */
function OnlineClaim({ t, onDone, flash }: { t: Detail; onDone: () => void; flash: (m: string, ok?: boolean) => void }) {
  const [account, setAccount] = React.useState(false);
  const [returnUnused, setReturnUnused] = React.useState<boolean | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  React.useEffect(() => {
    fetch("/api/dbaccount")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setAccount(!!d?.user && !!d?.hasPassword))
      .catch(() => {});
  }, []);
  const span = ticketSpan(t);
  const type = onlineClaimType(t, span.arrival);
  const sent = t.claims.some((c) => c.caseId || c.status !== "draft");
  if (!account || !t.orderNumber || !type || sent) return null;
  const asksReturn = t.roundTrip && t.direction !== "return" && type !== "verspaetung";
  const fmt = (iso: string | null) =>
    iso ? `${new Date(iso).toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" })} ${formatTime(iso)}` : "–";
  return (
    <div className="mt-3 space-y-2 border-t border-border pt-3 text-sm">
      <h3 className="font-medium">Online bei der DB einreichen</h3>
      <ul className="space-y-0.5 text-xs text-muted-foreground">
        <li>
          Antrag: <b className="text-foreground">{ONLINE_LABEL[type]}</b> · {t.direction === "return" ? "Rückfahrt" : "Hinfahrt"} · Auftrag{" "}
          {t.orderNumber}
        </li>
        <li>
          {span.from} {fmt(span.departure)} → {span.to} {fmt(span.arrival)}
        </li>
        {type === "abgebrochen" && <li>Abgebrochen in {t.abortedAt}</li>}
        {type === "verspaetung" && <li>Tatsächlich angekommen {fmt(t.actualArrival)}</li>}
        <li>Persönliche Daten und Auszahlung aus den Einstellungen · Bestätigung per E-Mail</li>
      </ul>
      {asksReturn && (
        <div className="flex flex-wrap gap-3 text-sm">
          <span className="text-xs text-muted-foreground">Rückfahrt:</span>
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={returnUnused === false} onChange={() => setReturnUnused(false)} /> wird/wurde genutzt
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={returnUnused === true} onChange={() => setReturnUnused(true)} /> nicht genutzt
          </label>
        </div>
      )}
      <Button
        size="sm"
        disabled={busy || (asksReturn && returnUnused == null)}
        onClick={async () => {
          if (!confirm("Antrag jetzt verbindlich bei der DB einreichen?")) return;
          setBusy(true);
          setErr(null);
          try {
            const res = await fetch(`/api/trips/${t.id}/claim/online`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ confirm: true, ...(asksReturn ? { returnUnused } : {}) }),
            });
            const d = await res.json().catch(() => ({}));
            if (!res.ok) setErr(d.error ?? "Einreichen fehlgeschlagen");
            else {
              flash(`Eingereicht – Fall-ID ${d.claim?.caseId ?? "?"}`);
              onDone();
            }
          } catch {
            setErr("Keine Verbindung");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? (
          <>
            <Spinner /> Meldet bei der DB an … (bis zu 1 Min.)
          </>
        ) : (
          "Online einreichen"
        )}
      </Button>
      {err && <p className="text-sm text-danger">{err}</p>}
    </div>
  );
}

function ClaimBox({ t, ent, onDone }: { t: Detail; ent: NonNullable<ReturnType<typeof assess>>; onDone: () => void }) {
  const [extra, setExtra] = React.useState({ ticket: false, transport: false, overnight: false, other: false });
  const [reservation, setReservation] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-semibold">{ent.title}</span>
        {ent.amount != null && (
          <span className={cn("text-lg font-bold", ent.payable ? "text-success" : "text-muted-foreground line-through")}>{formatEuro(ent.amount)}</span>
        )}
      </div>
      {ent.details.map((d) => (
        <p key={d} className="text-muted-foreground">
          {d}
        </p>
      ))}
      {ent.caveats.map((c) => (
        <p key={c} className="text-xs text-warning">
          {c}
        </p>
      ))}
      {!t.price && <p className="text-xs text-warning">Preis fehlt – oben bei „Ticketdaten“ eintragen, sonst kann die Höhe nicht berechnet werden.</p>}
      {ent.payable && ent.journey && (
        <>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">Zusatzkosten / Reservierung</summary>
            <div className="mt-2 grid gap-1 sm:grid-cols-2">
              {(
                [
                  ["ticket", "Zusätzliches Zugticket"],
                  ["transport", "Taxi / Bus"],
                  ["overnight", "Übernachtung"],
                  ["other", "Sonstiges"],
                ] as const
              ).map(([k, label]) => (
                <label key={k} className="flex items-center gap-2">
                  <input type="checkbox" checked={extra[k]} onChange={(e) => setExtra({ ...extra, [k]: e.target.checked })} /> {label}
                </label>
              ))}
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={reservation} onChange={(e) => setReservation(e.target.checked)} /> Reservierung nicht nutzbar
              </label>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">Belege für Zusatzkosten bitte mit einsenden (oben hochladen).</p>
          </details>
          <Button
            disabled={busy}
            onClick={async () => {
              setErr(null);
              setBusy(true);
              try {
                const res = await fetch(`/api/trips/${t.id}/claim`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ extra, reservationUnused: reservation }),
                });
                const d = await res.json().catch(() => ({}));
                if (!res.ok) return setErr(d.error ?? "Fehler");
                // Same-tab download (attachment): works on iOS Safari, unlike window.open after an await.
                window.location.assign(`/api/attachments/${d.attachment.id}?download`);
                onDone();
              } catch {
                setErr("Keine Verbindung – bitte erneut versuchen.");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Spinner /> : <FileDown className="h-4 w-4" />} Formular ausgefüllt herunterladen
          </Button>
          <p className="text-xs text-muted-foreground">
            Offizielles DB-Fahrgastrechte-Formular mit deinen Daten und deiner Unterschrift aus den Einstellungen (ohne
            gespeicherte Unterschrift: selbst unterschreiben). Per Post an „DB Fernverkehr AG, Servicecenter Fahrgastrechte, 60647
            Frankfurt am Main“ schicken oder im Reisezentrum abgeben.
          </p>
          {err && (
            <p className="text-sm text-danger">
              {err}{" "}
              {err.includes("Einstellungen") && (
                <Link href="/settings#fahrgastrechte" className="underline">
                  Zu den Einstellungen
                </Link>
              )}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function ClaimLine({ c, tripId, onSaved }: { c: ClaimRow; tripId: string; onSaved: () => void }) {
  const [paid, setPaid] = React.useState(c.paidAmount != null ? String(c.paidAmount).replace(".", ",") : "");
  async function save(body: Record<string, unknown>) {
    await fetch(`/api/trips/${tripId}/claim`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: c.id, ...body }),
    });
    onSaved();
  }
  const day = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString("de-DE") : null);
  return (
    <div className="space-y-1 text-sm">
    <div className="flex flex-wrap items-center gap-2">
      {c.caseId && <span className="font-medium">Fall {c.caseId}</span>}
      <span className="text-muted-foreground">{day(c.submittedAt) ? `eingereicht ${day(c.submittedAt)}` : `erstellt ${day(c.createdAt)}`}</span>
      <select
        className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
        value={c.status}
        onChange={(e) =>
          save({
            status: e.target.value,
            ...(e.target.value === "submitted" && !c.submittedAt ? { submittedAt: Date.now() } : {}),
            ...(e.target.value === "paid" && !c.paidAt ? { paidAt: Date.now() } : {}),
            ...((e.target.value === "paid" || e.target.value === "rejected") && !c.decidedAt ? { decidedAt: Date.now() } : {}),
          })
        }
      >
        {Object.entries(CLAIM_STATUS).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>
      {c.amount != null && c.status !== "paid" && <span>erwartet {formatEuro(c.amount)}</span>}
      {c.status === "paid" && (
        <span className="flex items-center gap-1">
          erhalten
          <Input className="h-8 w-20" inputMode="decimal" value={paid} onChange={(e) => setPaid(e.target.value)} onBlur={() => {
              const n = Number(paid.replace(",", "."));
              if (!paid.trim()) save({ paidAmount: null });
              else if (Number.isFinite(n) && n >= 0) save({ paidAmount: Math.round(n * 100) / 100 });
              else setPaid(c.paidAmount != null ? String(c.paidAmount).replace(".", ",") : "");
            }} />€
          {day(c.paidAt) && <span className="text-muted-foreground">am {day(c.paidAt)}</span>}
        </span>
      )}
      {c.status === "rejected" && day(c.decidedAt) && <span className="text-muted-foreground">am {day(c.decidedAt)}</span>}
    </div>
      {c.reason && <p className={cn("text-xs", c.status === "rejected" ? "text-danger" : "text-muted-foreground")}>{c.reason}</p>}
    </div>
  );
}
