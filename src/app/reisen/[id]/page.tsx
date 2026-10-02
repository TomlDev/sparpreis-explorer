"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Camera, FileDown, FileText, MapPin, Pencil, ShieldCheck, StickyNote, Trash2 } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { Badge, Button, Card, Input, Spinner } from "@/components/ui";
import { EventDialog } from "@/components/trips/EventDialog";
import { STATUS, legColor, legLabel, mapsLink, uploadFiles } from "@/components/trips/tripUi";
import type { AttachmentRow, ClaimRow, TripEventRow, TripRow } from "@/db/schema";
import { formatTime } from "@/lib/time";
import { arrivalDelayMin, assess, liveHints, ticketSpan } from "@/lib/trips/rules";
import { cn, formatEuro } from "@/lib/utils";

type Detail = TripRow & { events: TripEventRow[]; attachments: AttachmentRow[]; claims: ClaimRow[] };

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

/** Berlin wall time (yyyy-MM-dd + HH:mm) → ISO. */
function berlinIso(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const guess = new Date(`${date}T${time}:00Z`);
  const local = new Date(guess.toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
  const utc = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(guess.getTime() - (local.getTime() - utc.getTime())).toISOString();
}
const berlinDate = (iso: string) => new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });

export default function TripPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [t, setT] = React.useState<Detail | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [dialog, setDialog] = React.useState<{ event: TripEventRow | null; type: "control" | "note" } | null>(null);

  const load = React.useCallback(async () => {
    const res = await fetch(`/api/trips/${id}`);
    if (res.ok) setT((await res.json()).trip);
  }, [id]);
  React.useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 4000);
  };
  async function patch(body: Record<string, unknown>) {
    const res = await fetch(`/api/trips/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) flash((await res.json().catch(() => ({}))).error ?? "Speichern fehlgeschlagen");
    await load();
  }

  if (!t)
    return (
      <>
        <AppHeader />
        <main className="container py-10 text-center">
          <Spinner />
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
  const delay = arrivalDelayMin(span.arrival, t.actualArrival);
  const ent = assess({
    status: t.status,
    price: t.price,
    plannedArrival: span.arrival,
    actualArrival: t.actualArrival,
    expectedDelayMin: t.expectedDelayMin,
    returnedToStart: t.returnedToStart,
    roundTrip: t.roundTrip,
  });
  const screenshots = t.attachments.filter((a) => a.kind !== "claim" && a.kind !== "ticket");
  const tickets = t.attachments.filter((a) => a.kind === "ticket");
  const forms = t.attachments.filter((a) => a.kind === "claim");

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
          const err = await uploadFiles(t.id, e.target.files);
          setBusy(null);
          flash(err ?? "Gespeichert");
          e.target.value = "";
          load();
        }}
      />
      <main className="container max-w-3xl space-y-4 py-5">
        <Link href={`/reisen?m=${t.date.slice(0, 7)}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground">
          <ArrowLeft className="h-4 w-4" /> Alle Reisen
        </Link>

        {/* Header */}
        <Card className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="text-sm text-muted-foreground">{dayLabel(t.date)}</div>
              <h1 className="text-lg font-semibold">
                {t.originName} → {t.destName}
              </h1>
              <div className="tabular-nums text-sm">
                {formatTime(t.plannedDeparture)} – {formatTime(t.plannedArrival)}
                {t.actualArrival && (
                  <span className={cn("ml-2 font-semibold", (delay ?? 0) >= 60 ? "text-danger" : (delay ?? 0) >= 20 ? "text-warning" : "text-success")}>
                    {span.to}: tatsächlich {formatTime(t.actualArrival)} ({delay != null && delay > 0 ? `+${delay}` : delay} min)
                  </span>
                )}
              </div>
            </div>
            <span className={cn("rounded-full px-2.5 py-1 text-xs font-medium", STATUS[t.status]?.cls)}>
              {STATUS[t.status]?.label ?? t.status}
            </span>
          </div>
          <TicketFields t={t} onSave={patch} />
          {(t.ticket || tickets.length > 0) && (
            <div className="mt-3 space-y-1 border-t border-border pt-3 text-sm">
              {t.ticket?.tariff && (
                <div>
                  <b>{t.ticket.tariff}</b>
                  {t.klasse ? ` · ${t.klasse}. Klasse` : ""}
                  {t.ticket.bahncard ? ` · ${t.ticket.bahncard}` : ""}
                </div>
              )}
              {t.ticket?.from && (
                <div className="text-muted-foreground">
                  Ticket: {t.ticket.from} → {t.ticket.to}
                </div>
              )}
              {!!t.ticket?.zugbindung?.length && (
                <div className="text-muted-foreground">Zugbindung: {t.ticket.zugbindung.map((z) => z.split(",")[0]).join(", ")}</div>
              )}
              {t.ticket?.validity && <div className="text-xs text-muted-foreground">Gültig {t.ticket.validity}</div>}
              {tickets.map((a) => (
                <a key={a.id} href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline">
                  <FileText className="h-4 w-4" /> Ticket öffnen
                </a>
              ))}
            </div>
          )}
        </Card>

        {/* Quick actions */}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setDialog({ event: null, type: "control" })}>
            <ShieldCheck className="h-4 w-4" /> Kontrolliert
          </Button>
          <Button variant="outline" disabled={busy === "upload"} onClick={() => fileRef.current?.click()}>
            {busy === "upload" ? <Spinner /> : <Camera className="h-4 w-4" />} Screenshot / Beleg
          </Button>
          <Button variant="outline" onClick={() => setDialog({ event: null, type: "note" })}>
            <StickyNote className="h-4 w-4" /> Notiz
          </Button>
        </div>
        {msg && <p className="text-sm font-medium text-success">{msg}</p>}
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
          }}
        />

        {/* Timeline with events */}
        <Card className="p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Verbindung</h2>
          <div className="space-y-2 text-sm">
            {t.legs.map((l, i) => (
              <div key={i}>
                <div className="flex items-center gap-2">
                  <span className="w-12 shrink-0 tabular-nums font-semibold">{formatTime(l.plannedDeparture)}</span>
                  <span className="truncate">{l.fromName}</span>
                </div>
                <div className="ml-12 flex flex-wrap items-center gap-2 border-l-2 border-dashed border-border py-1 pl-3">
                  {l.isWalking ? (
                    <span className="text-xs text-muted-foreground">Fußweg</span>
                  ) : (
                    <span className={cn("rounded px-2 py-0.5 text-xs font-semibold", legColor(l))}>{legLabel(l)}</span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {l.depPlatform ? `Gl. ${l.depPlatform} ` : ""}→ {l.toName} an {formatTime(l.plannedArrival)}
                    {l.arrPlatform ? ` · Gl. ${l.arrPlatform}` : ""}
                  </span>
                </div>
                {(eventsByLeg.get(i) ?? []).map((e) => (
                  <EventLine key={e.id} e={e} tripId={t.id} onDeleted={load} onEdit={() => setDialog({ event: e, type: e.type === "note" ? "note" : "control" })} />
                ))}
              </div>
            ))}
            <div className="flex items-center gap-2">
              <span className="w-12 shrink-0 tabular-nums font-semibold">{formatTime(t.plannedArrival)}</span>
              <span className="font-semibold">{t.destName}</span>
            </div>
            {loose.map((e) => (
              <EventLine key={e.id} e={e} tripId={t.id} onDeleted={load} onEdit={() => setDialog({ event: e, type: e.type === "note" ? "note" : "control" })} />
            ))}
          </div>
        </Card>

        <WhatHappened t={t} onSave={patch} />

        {/* Compensation */}
        <Card className="p-4">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Fahrgastrechte</h2>
          {ent ? (
            <ClaimBox t={t} ent={ent} onDone={load} />
          ) : (
            <p className="text-sm text-muted-foreground">
              {t.status === "planned"
                ? "Nach der Fahrt oben eintragen, was passiert ist – dann rechnet die App aus, was dir zusteht."
                : "Laut den DB-Regeln besteht kein Anspruch (Entschädigung erst ab 60 min Verspätung am Ziel)."}
              {liveHints(delay).length > 0 && <span className="mt-1 block">{liveHints(delay)[0]}</span>}
            </p>
          )}
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
        </Card>

        {/* Evidence */}
        <Card className="p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Screenshots & Belege ({screenshots.length})
          </h2>
          {screenshots.length === 0 ? (
            <p className="text-sm text-muted-foreground">Noch nichts hochgeladen – z. B. Screenshot der Verspätungsprognose im DB Navigator.</p>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {screenshots.map((a) => (
                <div key={a.id} className="group relative overflow-hidden rounded-lg border border-border">
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
                      aria-label="Löschen"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

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

function EventLine({ e, tripId, onDeleted, onEdit }: { e: TripEventRow; tripId: string; onDeleted: () => void; onEdit: () => void }) {
  return (
    <div className="ml-12 flex items-center gap-2 border-l-2 border-dashed border-border py-0.5 pl-3 text-xs">
      {e.type === "control" ? <ShieldCheck className="h-3.5 w-3.5 text-success" /> : <StickyNote className="h-3.5 w-3.5 text-muted-foreground" />}
      <span className="tabular-nums font-medium">{timeOf(e.at)}</span>
      <span>{EVENT_LABEL[e.type] ?? e.type}</span>
      {e.text && <span className="text-muted-foreground">– {e.text}</span>}
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
        <button className="text-primary underline" onClick={onEdit}>
          Ort setzen
        </button>
      )}
      <button className="ml-auto text-muted-foreground" onClick={onEdit} aria-label="Bearbeiten">
        <Pencil className="h-3 w-3" />
      </button>
      <button
        className="text-muted-foreground"
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
  );
}

function TicketFields({ t, onSave }: { t: Detail; onSave: (b: Record<string, unknown>) => Promise<void> }) {
  const [open, setOpen] = React.useState(false);
  const [f, setF] = React.useState({
    price: t.price != null ? String(t.price).replace(".", ",") : "",
    orderNumber: t.orderNumber ?? "",
    ticketType: t.ticketType ?? "",
    direction: t.direction ?? "outbound",
    roundTrip: t.roundTrip,
  });
  if (!open)
    return (
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
        <span>{t.price != null ? formatEuro(t.price) : "Preis fehlt"}</span>
        <span>{t.orderNumber ? `Auftrag ${t.orderNumber}` : "keine Auftragsnummer"}</span>
        {t.ticketType && <span>{t.ticketType}</span>}
        {t.roundTrip && <Badge variant="outline">Hin- und Rückfahrt</Badge>}
        <button className="text-primary underline" onClick={() => setOpen(true)}>
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
      <div className="flex gap-2 sm:col-span-2">
        <Button
          size="sm"
          onClick={async () => {
            const price = f.price.trim() ? Number(f.price.replace(",", ".")) : null;
            await onSave({
              price: price != null && Number.isFinite(price) ? price : null,
              orderNumber: f.orderNumber.trim() || null,
              ticketType: f.ticketType.trim() || null,
              direction: f.direction,
              roundTrip: f.roundTrip,
            });
            setOpen(false);
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
function WhatHappened({ t, onSave }: { t: Detail; onSave: (b: Record<string, unknown>) => Promise<void> }) {
  const span = ticketSpan(t);
  const stations = Array.from(new Set(t.legs.flatMap((l) => [l.fromName, l.toName])));
  const [status, setStatus] = React.useState(t.status);
  const [arrDate, setArrDate] = React.useState(t.actualArrival ? berlinDate(t.actualArrival) : span.arrival ? berlinDate(span.arrival) : t.date);
  const [arrTime, setArrTime] = React.useState(t.actualArrival ? formatTime(t.actualArrival) : "");
  const [abortedAt, setAbortedAt] = React.useState(t.abortedAt ?? t.originName);
  const [returned, setReturned] = React.useState(t.returnedToStart);
  const [expected, setExpected] = React.useState(t.expectedDelayMin != null ? String(t.expectedDelayMin) : "");
  const [notes, setNotes] = React.useState(t.notes ?? "");
  const [saved, setSaved] = React.useState(false);

  const options: [string, string][] = [
    ["done", "Wie geplant / pünktlich"],
    ["delayed", "Verspätet angekommen"],
    ["aborted", "Unterwegs abgebrochen"],
    ["not_started", "Nicht angetreten"],
    ["cancelled", "Zug fiel aus"],
  ];
  const needsArrival = status === "delayed" || status === "done";
  const needsExpected = status === "aborted" || status === "not_started";

  return (
    <Card className="p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Was ist passiert?</h2>
      <div className="flex flex-wrap gap-1.5">
        {options.map(([k, label]) => (
          <button
            key={k}
            onClick={() => setStatus(k)}
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm",
              status === k ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
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
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">Abgebrochen in</span>
            <select className="h-10 rounded-xl border border-input bg-background px-3" value={abortedAt} onChange={(e) => setAbortedAt(e.target.value)}>
              {stations.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <span className="flex items-center gap-2">
              <input type="checkbox" checked={returned} onChange={(e) => setReturned(e.target.checked)} /> zurück zum Startbahnhof gefahren
            </span>
          </label>
        )}
        {needsExpected && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">Angekündigte Verspätung am Ziel (min)</span>
            <Input inputMode="numeric" placeholder="z. B. 75" value={expected} onChange={(e) => setExpected(e.target.value.replace(/\D/g, ""))} />
          </label>
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
        onClick={async () => {
          const iso = needsArrival && arrTime ? berlinIso(arrDate, arrTime) : null;
          await onSave({
            status,
            actualArrival: needsArrival ? iso : null,
            abortedAt: status === "aborted" ? abortedAt : null,
            returnedToStart: status === "aborted" ? returned : false,
            expectedDelayMin: needsExpected && expected ? Number(expected) : null,
            notes: notes.trim() || null,
          });
          setSaved(true);
          setTimeout(() => setSaved(false), 1500);
        }}
      >
        {saved ? "Gespeichert ✓" : "Speichern"}
      </Button>
    </Card>
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
      {ent.payable && (
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
              const res = await fetch(`/api/trips/${t.id}/claim`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ extra, reservationUnused: reservation }),
              });
              const d = await res.json().catch(() => ({}));
              setBusy(false);
              if (!res.ok) return setErr(d.error ?? "Fehler");
              window.open(`/api/attachments/${d.attachment.id}?download`, "_blank");
              onDone();
            }}
          >
            {busy ? <Spinner /> : <FileDown className="h-4 w-4" />} Formular ausgefüllt herunterladen
          </Button>
          <p className="text-xs text-muted-foreground">
            Offizielles DB-Fahrgastrechte-Formular mit deinen Daten aus den Einstellungen. Unterschreiben und per Post an
            „DB Fernverkehr AG, Servicecenter Fahrgastrechte, 60647 Frankfurt am Main“ schicken (oder im Reisezentrum abgeben).
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
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">{new Date(c.createdAt).toLocaleDateString("de-DE")}</span>
      <select
        className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
        value={c.status}
        onChange={(e) =>
          save({
            status: e.target.value,
            ...(e.target.value === "submitted" && !c.submittedAt ? { submittedAt: Date.now() } : {}),
            ...(e.target.value === "paid" && !c.paidAt ? { paidAt: Date.now() } : {}),
          })
        }
      >
        {Object.entries(CLAIM_STATUS).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>
      {c.amount != null && <span>erwartet {formatEuro(c.amount)}</span>}
      {c.status === "paid" && (
        <span className="flex items-center gap-1">
          erhalten
          <Input className="h-8 w-20" inputMode="decimal" value={paid} onChange={(e) => setPaid(e.target.value)} onBlur={() => save({ paidAmount: paid ? Number(paid.replace(",", ".")) : null })} />€
        </span>
      )}
    </div>
  );
}
