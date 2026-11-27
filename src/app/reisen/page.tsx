"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, FileUp, Plus } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { CopyCode } from "@/components/CopyCode";
import { Toast } from "@/components/Toast";
import { Chevron, FoldHeading, useStoredOpen } from "@/components/Collapsible";
import { Button, Card, Input, Spinner } from "@/components/ui";
import { BahnCards, CalendarSubscribe, Promos, Reminders, useAccount } from "@/components/trips/AccountPanel";
import { STATUS } from "@/components/trips/tripUi";
import type { TripRow } from "@/db/schema";
import type { ClaimBrief } from "@/lib/trips/repo";
import { journeyGroups, planStates, type PlanInfo } from "@/lib/trips/plan";
import { TripTimeline } from "@/components/trips/TripTimeline";
import { liftedUsableUntil } from "@/lib/trips/rules";
import { berlinToIso, formatTime } from "@/lib/time";
import { cn, formatEuro } from "@/lib/utils";

const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

function monthBounds(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7; // Monday-first
  const trail = (7 - ((lead + days) % 7)) % 7;
  const day = (offset: number) => new Date(Date.UTC(y, m - 1, 1 + offset)).toISOString().slice(0, 10);
  return {
    y,
    m,
    days,
    lead,
    trail,
    from: `${ym}-01`,
    to: `${ym}-${String(days).padStart(2, "0")}`,
    // the whole weeks shown: days of the neighbouring months included
    gridFrom: day(-lead),
    gridTo: day(days - 1 + trail),
    day,
  };
}
const shiftMonth = (ym: string, d: number) => {
  const [y, m] = ym.split("-").map(Number);
  const i = y * 12 + (m - 1) + d;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
};
const todayStr = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
/** default validity of a new voucher: a year from today */
const inOneYear = () => {
  const [y, m, d] = todayStr().split("-").map(Number);
  return new Date(Date.UTC(y + 1, m - 1, d)).toISOString().slice(0, 10);
};

export default function TripsPage() {
  const [month, setMonth] = React.useState(() => todayStr().slice(0, 7));
  const [trips, setTrips] = React.useState<TripRow[]>([]);
  const [adding, setAdding] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [importMsg, setImportMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const importRef = React.useRef<HTMLInputElement>(null);
  const { acc, load: loadAccount, act } = useAccount();
  const [nextIds, setNextIds] = React.useState<string[]>([]);
  /** Bumped after an import / new trip → side sections reload (not on month changes). */
  const [rev, setRev] = React.useState(0);

  async function importFiles(files: FileList) {
    setImporting(true);
    setImportMsg(null);
    const fd = new FormData();
    for (const f of Array.from(files)) fd.append("file", f);
    let d: { results?: unknown[] } = {};
    try {
      const res = await fetch("/api/trips/import", { method: "POST", body: fd });
      if (!res.ok) {
        setImporting(false);
        return setImportMsg({ ok: false, text: res.status === 413 ? "Import fehlgeschlagen: Datei zu groß" : `Import fehlgeschlagen (${res.status})` });
      }
      d = await res.json();
    } catch {
      setImporting(false);
      return setImportMsg({ ok: false, text: "Import fehlgeschlagen – keine Verbindung" });
    }
    setImporting(false);
    type R = { file: string; error?: string; created?: TripRow[]; updated?: TripRow[]; warnings?: string[]; claims?: unknown[]; skipped?: string };
    const results = (d.results ?? []) as R[];
    const created = results.flatMap((r) => r.created ?? []);
    const updated = results.flatMap((r) => r.updated ?? []);
    const errors = results.filter((r) => r.error).map((r) => `${r.file}: ${r.error}`);
    const warn = results.flatMap((r) => r.warnings ?? []);
    const claimCount = results.reduce((n, r) => n + (r.claims?.length ?? 0), 0);
    const skipped = results.flatMap((r) => (r.skipped ? [r.skipped] : []));
    const first = created[0] ?? updated[0];
    if (first) setMonth(first.date.slice(0, 7));
    setImportMsg({
      ok: errors.length === 0,
      text: [
        created.length ? `${created.length} Fahrt(en) importiert` : "",
        updated.length ? `${updated.length} aktualisiert` : "",
        claimCount ? `${claimCount} Fahrgastrechte-Antrag/-Bescheid übernommen` : "",
        ...skipped,
        ...warn,
        ...errors,
      ]
        .filter(Boolean)
        .join(" · ") || "Nichts gefunden",
    });
    if (!first) load(); // a month change reloads by itself
    loadAccount();
    setRev((r) => r + 1);
  }

  React.useEffect(() => {
    const m = new URLSearchParams(window.location.search).get("m");
    if (m && /^\d{4}-\d{2}$/.test(m)) setMonth(m);
  }, []);

  const b = monthBounds(month);
  // Only the newest request may set the list (fast month clicks, ?m= on first load).
  const reqId = React.useRef(0);
  const load = React.useCallback(async () => {
    const id = ++reqId.current;
    try {
      const r = await fetch(`/api/trips?from=${b.gridFrom}&to=${b.gridTo}`);
      const d = r.ok ? await r.json() : { trips: [] };
      if (id === reqId.current) setTrips(d.trips ?? []);
    } catch {
      /* offline: keep what is shown */
    }
  }, [b.gridFrom, b.gridTo]);
  React.useEffect(() => {
    load();
    window.history.replaceState(null, "", `?m=${month}${window.location.hash}`); // keep #gutscheine etc.
  }, [load, month]);

  const remindersByDay = new Map<string, string[]>();
  for (const r of acc?.reminders ?? []) if (r.kind !== "trip") remindersByDay.set(r.date, [...(remindersByDay.get(r.date) ?? []), r.title]);
  const byDay = new Map<string, TripRow[]>();
  for (const t of trips) byDay.set(t.date, [...(byDay.get(t.date) ?? []), t]);
  const plans = planStates(trips);
  const today = todayStr();
  // Trips already shown under "Als Nächstes" aren't repeated below the calendar.
  const monthTrips = trips.filter((t) => t.date >= b.from && t.date <= b.to);
  const rest = monthTrips.filter((t) => !nextIds.includes(t.id));
  const title = new Date(Date.UTC(b.y, b.m - 1, 15)).toLocaleDateString("de-DE", { month: "long", year: "numeric" });
  const cal = useStoredOpen("calendarGrid", true);
  const monthList = useStoredOpen("monthTrips", true);

  return (
    <>
      <AppHeader />
      <main className="container max-w-4xl space-y-4 py-5">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-xl font-semibold">Meine Reisen</h1>
          <div className="flex gap-2">
            <input
              ref={importRef}
              type="file"
              multiple
              // image/* → on the phone also "Fotomediathek" / "Foto aufnehmen" (ticket screenshots, paper tickets)
              accept=".eml,.pdf,.ics,message/rfc822,application/pdf,text/calendar,image/*"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) importFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <Button size="sm" variant="outline" disabled={importing} onClick={() => importRef.current?.click()} title="DB-Buchungsmail (.eml), Ticket-PDF, .ics oder Foto/Screenshot des Tickets">
              {importing ? <Spinner /> : <FileUp className="h-4 w-4" />} Import
            </Button>
            <Button size="sm" onClick={() => setAdding((a) => !a)}>
              <Plus className="h-4 w-4" /> Eintragen
            </Button>
          </div>
        </div>
        {importMsg && <p className={cn("text-sm", importMsg.ok ? "text-success" : "text-danger")}>{importMsg.text}</p>}
        {adding && (
          <AddTrip
            onDone={(t) => {
              setAdding(false);
              if (t && t.date.slice(0, 7) !== month) setMonth(t.date.slice(0, 7));
              else load();
              setRev((r) => r + 1);
            }}
          />
        )}

        <NextTrips
          key={`n${rev}`}
          onShown={setNextIds}
          onChanged={() => {
            load();
            setRev((r) => r + 1);
          }}
        />

        <Card className="p-3 sm:p-4">
          <div className="mb-3 flex items-center justify-between">
            <Button variant="ghost" size="icon" onClick={() => setMonth((m) => shiftMonth(m, -1))} aria-label="Voriger Monat">
              <ChevronLeft className="h-5 w-5" />
            </Button>
            <button className="font-semibold" onClick={() => setMonth(today.slice(0, 7))} title="Zum aktuellen Monat">
              {title}
            </button>
            <div className="flex items-center">
              <Button variant="ghost" size="icon" onClick={() => setMonth((m) => shiftMonth(m, 1))} aria-label="Nächster Monat">
                <ChevronRight className="h-5 w-5" />
              </Button>
              <Button variant="ghost" size="icon" onClick={cal.toggle} aria-expanded={cal.open} aria-label={cal.open ? "Kalender einklappen" : "Kalender aufklappen"}>
                <Chevron open={cal.open} />
              </Button>
            </div>
          </div>
          {cal.open && (
          <>
          <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground">
            {WEEKDAYS.map((w) => (
              <div key={w}>{w}</div>
            ))}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-1">
            {/* whole weeks: days of the neighbouring months greyed, with their trips */}
            {Array.from({ length: b.lead + b.days + b.trail }, (_, k) => {
              const day = b.day(k - b.lead);
              const other = k < b.lead || k >= b.lead + b.days;
              const list = byDay.get(day) ?? [];
              return (
                <div
                  key={day}
                  className={cn(
                    "min-h-[3.5rem] rounded-lg border border-border p-0.5 text-left text-[10px] sm:min-h-[4.5rem] sm:p-1 sm:text-[11px]",
                    day === today && "border-primary ring-1 ring-primary",
                    other ? "border-dashed bg-muted/30 opacity-50" : list.length === 0 && "opacity-70",
                  )}
                >
                  <div className={cn("mb-0.5 flex items-center justify-between text-xs", day === today ? "font-bold text-primary" : "text-muted-foreground")}>
                    {Number(day.slice(8))}
                    {remindersByDay.has(day) && (
                      <span title={remindersByDay.get(day)!.join("\n")} className="text-warning">
                        ⏰
                      </span>
                    )}
                  </div>
                  {list.map((t) => (
                    <Link
                      key={t.id}
                      href={`/reisen/${t.id}`}
                      className={cn(
                        "mb-0.5 flex items-center gap-0.5 overflow-hidden rounded bg-muted/60 px-0.5 py-0.5 hover:bg-muted sm:gap-1 sm:px-1",
                        t.status === "planned" && plans.get(t.id)?.state === "skip" && "line-through opacity-50",
                        t.status === "planned" && plans.get(t.id)?.state === "open" && "ring-1 ring-warning",
                      )}
                      title={`${formatTime(t.plannedDeparture)} ${t.originName} → ${t.destName} · ${STATUS[t.status]?.label ?? t.status}${planTitle(t, plans.get(t.id))}`}
                    >
                      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS[t.status]?.dot)} />
                      <span className="tabular-nums">{formatTime(t.plannedDeparture)}</span>
                      <span className="hidden truncate sm:inline">{t.destName}</span>
                    </Link>
                  ))}
                </div>
              );
            })}
          </div>
          </>
          )}
        </Card>

        <div className="space-y-2">
          {rest.length > 0 && (
            <FoldHeading open={monthList.open} onToggle={monthList.toggle}>
              {rest.length < monthTrips.length ? "Weitere Fahrten" : "Fahrten"} im {title}
              {!monthList.open && <span className="ml-1.5 font-normal normal-case">({journeyGroups(rest).length})</span>}
            </FoldHeading>
          )}
          {monthTrips.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Keine Fahrten in diesem Monat. In der Suche bei einer Verbindung auf <b>„Gebucht“</b> tippen oder oben eine
              Fahrt eintragen.
            </p>
          )}
          {monthList.open && journeyGroups(rest).map((g) => (
            <TripCard key={g[0].id} group={g} plans={plans} onChanged={load} />
          ))}
        </div>

        {acc && <Reminders list={acc.reminders} />}
        <ClaimsSummary key={`c${rev}`} />
        {acc && <BahnCards acc={acc} act={act} />}
        <OpenTickets key={`o${rev}`} />
        <Vouchers key={`v${rev}`} />
        {acc && <Promos list={acc.promos} />}
        {acc && <CalendarSubscribe url={acc.calendarUrl} act={act} />}
      </main>
    </>
  );
}

const planTitle = (t: TripRow, p: PlanInfo | undefined) =>
  t.status !== "planned" || !p?.state ? "" : p.state === "take" ? " · nehme ich" : p.state === "skip" ? " · nehme ich nicht" : " · doppelt gebucht";

async function setPlan(id: string, plan: "take" | "skip" | null) {
  await fetch(`/api/trips/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plan }) }).catch(() => {});
}

/** Passenger-rights state on a trip card: "Antrag offen 11,20 €" / "44,24 € erstattet" / "Antrag abgelehnt". */
function claimChip(c: ClaimBrief): { text: string; cls: string } {
  if (c.status === "paid") return { text: `${c.paidAmount != null ? formatEuro(c.paidAmount) : "Antrag"} erstattet`, cls: "bg-success/15 text-success" };
  if (c.status === "rejected") return { text: "Antrag abgelehnt", cls: "bg-danger/10 text-danger" };
  if (c.status === "followup") return { text: "Antrag in Klärung", cls: "bg-warning/15 text-warning" };
  if (c.status === "query") return { text: "DB fragt nach", cls: "bg-warning/15 text-warning" };
  if (c.status === "submitted") return { text: `Antrag offen${c.amount != null ? ` ${formatEuro(c.amount)}` : ""}`, cls: "bg-primary/15 text-primary" };
  return { text: "Antrag nicht eingereicht", cls: "bg-muted text-muted-foreground" };
}

type ListTrip = TripRow & { claim?: ClaimBrief | null };

const shortDate = (d: string) => {
  const x = new Date(`${d}T12:00:00Z`);
  return `${x.toLocaleDateString("de-DE", { weekday: "short", timeZone: "UTC" }).replace(".", "")} ${x.getUTCDate()}.${x.getUTCMonth() + 1}.`;
};
const textOf = (cls: string | undefined) => cls?.split(" ").find((c) => c.startsWith("text-")) ?? "";

/** What a booking's state says, as short coloured words (no boxes). */
// "journey": what is about the trains (same for every booking of it); "booking": what is about this ticket
function stateWords(t: ListTrip, plan: PlanInfo | undefined, part: "all" | "journey" | "booking" = "all") {
  const state = t.status === "planned" ? (plan?.state ?? null) : null;
  const w: { text: string; cls: string }[] = [];
  if (part !== "journey") w.push({ text: STATUS[t.status]?.label ?? t.status, cls: t.status === "planned" ? "text-muted-foreground" : textOf(STATUS[t.status]?.cls) });
  if (part !== "booking") {
    if (t.ticket?.scheduleChange?.zugbindungLifted) w.push({ text: "Zugbindung aufgehoben", cls: "text-warning" });
    else if (t.ticket?.scheduleChange) w.push({ text: "Fahrplan geändert", cls: "text-warning" });
  }
  if (part === "journey") return w;
  if (t.claim) w.push({ text: claimChip(t.claim).text, cls: textOf(claimChip(t.claim).cls) });
  if (t.movedFrom) w.push({ text: "🔁 Ersatzfahrt", cls: "text-primary" });
  if (state === "take" && !plan?.implied) w.push({ text: "✓ Nehme ich", cls: "text-success" });
  if (state === "skip") w.push({ text: "Nehme ich nicht", cls: "text-muted-foreground" });
  if (state === "open") w.push({ text: "Doppelt gebucht", cls: "text-warning" });
  return w;
}

function PlanButtons({ id, onChanged }: { id: string; onChanged?: () => void }) {
  const b = (plan: "take" | "skip", label: string, cls: string) => (
    <button
      type="button"
      className={cn("rounded border px-1.5 py-0.5 text-[11px] font-semibold", cls)}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await setPlan(id, plan);
        onChanged?.();
      }}
    >
      {label}
    </button>
  );
  return (
    <>
      {b("take", "✓ Die nehme ich", "border-success text-success hover:bg-success/10")}
      {b("skip", "✗ Nehme ich nicht", "border-border text-muted-foreground hover:bg-muted")}
    </>
  );
}

/**
 * One journey: date, route, the trains as a bar (each as long as it runs, names
 * below), state in words. Bookings of the same journey (a spare) are one card –
 * it opens the one taken, the trip page switches between them.
 */
function TripCard({ group, plans, onChanged }: { group: ListTrip[]; plans: Map<string, PlanInfo>; onChanged?: () => void }) {
  const t = group[0];
  const many = group.length > 1;
  const plan = plans.get(t.id);
  const words = stateWords(t, plan, many ? "journey" : "all");
  const changes = t.legs.filter((l) => !l.isWalking).length - 1;
  const skipped = !many && t.status === "planned" && plan?.state === "skip";
  const open = group.some((x) => x.status === "planned" && plans.get(x.id)?.state === "open");
  return (
    <Link href={`/reisen/${t.id}`} className="block">
      <Card className={cn("space-y-1.5 p-3 hover:bg-muted/40", skipped && "opacity-60", open && "border-warning")}>
        <div className="flex items-baseline gap-2 text-sm">
          <span className="shrink-0 font-semibold">{shortDate(t.date)}</span>
          <span className="min-w-0 flex-1 truncate font-medium">
            {t.originName} → {t.destName}
          </span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {many ? `${group.length} Buchungen` : t.price != null ? formatEuro(t.price) : ""}
          </span>
        </div>
        {t.plannedDeparture && t.plannedArrival ? (
          <TripTimeline legs={t.legs} from={t.plannedDeparture} to={t.plannedArrival} />
        ) : (
          <div className="text-xs text-muted-foreground">Zeit unbekannt</div>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-semibold">
          {words.map((w) => (
            <span key={w.text} className={w.cls}>
              {w.text}
            </span>
          ))}
          {!many && plan?.state === "open" && t.status === "planned" && <PlanButtons id={t.id} onChanged={onChanged} />}
          {changes > 0 && <span className="ml-auto whitespace-nowrap font-normal text-muted-foreground">{changes}× umsteigen</span>}
        </div>
        {many && (
          <div className="space-y-1 text-xs">
            {group.map((x) => {
              const p = plans.get(x.id);
              return (
                <div key={x.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="tabular-nums text-muted-foreground">
                    {x.orderNumber ? `Auftrag …${x.orderNumber.slice(-4)}` : "Buchung"}
                    {x.price != null ? ` · ${formatEuro(x.price)}` : ""}
                  </span>
                  {stateWords(x, p, "booking").map((w) => (
                    <span key={w.text} className={cn("font-semibold", w.cls)}>
                      {w.text}
                    </span>
                  ))}
                  {p?.state === "open" && x.status === "planned" && <PlanButtons id={x.id} onChanged={onChanged} />}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </Link>
  );
}

/** The next trip from today on — independent of the month shown. */
function NextTrips({ onShown, onChanged }: { onShown: (ids: string[]) => void; onChanged: () => void }) {
  const [list, setList] = React.useState<TripRow[][] | null>(null);
  const [plans, setPlans] = React.useState<Map<string, PlanInfo>>(new Map());
  const { open, toggle } = useStoredOpen("nextTrip", true);
  React.useEffect(() => {
    const from = todayStr();
    const to = new Date(Date.now() + 365 * 86_400_000).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
    fetch(`/api/trips?from=${from}&to=${to}`)
      .then((r) => (r.ok ? r.json() : { trips: [] }))
      .then((d) => {
        const now = Date.now();
        // still to come (or under way today); skip trips that didn't take place
        const all = (d.trips ?? []) as TripRow[];
        const plans = planStates(all);
        setPlans(plans);
        const up = all.filter(
          (t) =>
            !["not_started", "cancelled", "moved", "lifted"].includes(t.status) &&
            plans.get(t.id)?.state !== "skip" &&
            (!t.plannedArrival || new Date(t.plannedArrival).getTime() > now - 3600_000),
        );
        // with its spare booking(s), as in the month list
        const g = up.length ? journeyGroups(all).filter((g) => g.some((t) => t.id === up[0].id)) : [];
        setList(g);
        onShown(g.flat().map((t) => t.id));
      })
      .catch(() => setList([]));
  }, [onShown]);
  if (!list?.length) return null;
  return (
    <div className="space-y-2">
      <FoldHeading open={open} onToggle={toggle}>
        Nächste Fahrt
        {!open && list[0]?.[0] && (
          <span className="ml-1.5 font-normal normal-case">
            {shortDate(list[0][0].date)} {formatTime(list[0][0].plannedDeparture)} → {list[0][0].destName}
          </span>
        )}
      </FoldHeading>
      {open && list.map((g) => (
        <TripCard key={g[0].id} group={g} plans={plans} onChanged={onChanged} />
      ))}
    </div>
  );
}

/** Minimal manual entry: one train (more detail can be added later). */
function AddTrip({ onDone }: { onDone: (t: TripRow | null) => void }) {
  const [f, setF] = React.useState({ from: "", to: "", date: todayStr(), dep: "", arr: "", train: "", price: "", order: "" });
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((o) => ({ ...o, [k]: e.target.value }));
  const iso = (time: string) => berlinToIso(f.date, time);

  async function save() {
    setErr(null);
    const dep = iso(f.dep);
    let arr = iso(f.arr);
    if (!f.from || !f.to || !dep || !arr) return setErr("Von, Nach, Abfahrt und Ankunft ausfüllen.");
    if (arr < dep) arr = new Date(new Date(arr).getTime() + 86_400_000).toISOString(); // over midnight
    const price = f.price.trim() ? Number(f.price.replace(",", ".")) : null;
    if (price != null && (!Number.isFinite(price) || price < 0)) return setErr("Preis prüfen.");
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "manual",
          price,
          orderNumber: f.order.trim() || null,
          legs: [{ fromName: f.from.trim(), toName: f.to.trim(), lineName: f.train.trim() || undefined, plannedDeparture: dep, plannedArrival: arr }],
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) return setErr(d.error ?? "Fehler");
      onDone(d.trip);
    } catch {
      setErr("Keine Verbindung – bitte erneut versuchen.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="grid gap-2 sm:grid-cols-2">
        <Input placeholder="Von (Bahnhof)" value={f.from} onChange={set("from")} />
        <Input placeholder="Nach (Bahnhof)" value={f.to} onChange={set("to")} />
        <Input type="date" value={f.date} onChange={set("date")} />
        <div className="flex gap-2">
          <Input type="time" value={f.dep} onChange={set("dep")} aria-label="Abfahrt" />
          <Input type="time" value={f.arr} onChange={set("arr")} aria-label="Ankunft" />
        </div>
        <Input placeholder="Zug (optional, z. B. ICE 105)" value={f.train} onChange={set("train")} />
        <div className="flex gap-2">
          <Input placeholder="Preis €" inputMode="decimal" value={f.price} onChange={set("price")} />
          <Input placeholder="Auftragsnummer" value={f.order} onChange={set("order")} />
        </div>
      </div>
      {err && <p className="text-sm text-danger">{err}</p>}
      <div className="flex gap-2">
        <Button onClick={save} disabled={busy}>
          {busy ? <Spinner /> : "Speichern"}
        </Button>
        <Button variant="ghost" onClick={() => onDone(null)}>
          Abbrechen
        </Button>
      </div>
    </Card>
  );
}

interface ClaimsOverview {
  paidTotal: number;
  paidCount: number;
  pending: number;
  drafts: number;
  rejected: number;
  claims: { id: string; caseId: string | null; status: string; paidAmount: number | null; amount: number | null; tripId: string; date: string; route: string }[];
}

const CLAIM_LABEL: Record<string, string> = { draft: "Formular erstellt", submitted: "Eingereicht", query: "Rückfrage der DB", followup: "In Klärung", paid: "Ausgezahlt", rejected: "Abgelehnt" };

/** Passenger-rights overview: money received, open and rejected claims. */
function ClaimsSummary() {
  const [d, setD] = React.useState<ClaimsOverview | null>(null);
  const { open, toggle } = useStoredOpen("claims", false);
  React.useEffect(() => {
    fetch("/api/claims")
      .then((r) => (r.ok ? r.json() : null))
      .then((x) => x?.claims && setD(x))
      .catch(() => {});
  }, []);
  if (!d || d.claims.length === 0) return null;
  return (
    <Card className="p-3 sm:p-4">
      <button className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 text-left text-sm" onClick={toggle}>
        <span className="font-semibold">Fahrgastrechte</span>
        <span className="font-semibold text-success">{formatEuro(d.paidTotal)} erstattet</span>
        {d.pending > 0 && <span>{d.pending} offen</span>}
        {d.drafts > 0 && <span className="text-muted-foreground">{d.drafts} noch nicht eingereicht</span>}
        {d.rejected > 0 && <span className="text-danger">{d.rejected} abgelehnt</span>}
        <span className="ml-auto flex items-center gap-1 self-center text-xs text-muted-foreground">
          {!open && `${d.claims.length} Anträge`}
          <Chevron open={open} />
        </span>
      </button>
      {open && (
        <div className="mt-2 divide-y divide-border text-sm">
          {d.claims.map((c) => (
            <Link key={c.id} href={`/reisen/${c.tripId}#fahrgastrechte`} className="flex flex-wrap items-center gap-x-3 py-1.5 hover:bg-muted/40">
              <span className="w-20 tabular-nums text-muted-foreground">{new Date(`${c.date}T12:00:00Z`).toLocaleDateString("de-DE")}</span>
              <span className="min-w-0 flex-1 truncate">{c.route}</span>
              <span
                className={cn(
                  "text-xs",
                  c.status === "paid" ? "text-success" : c.status === "rejected" ? "text-danger" : "text-muted-foreground",
                )}
              >
                {CLAIM_LABEL[c.status] ?? c.status}
                {c.status === "paid" && c.paidAmount != null ? ` ${formatEuro(c.paidAmount)}` : ""}
              </span>
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}

/** Tickets not used yet (Zugbindung lifted): usable up to a year after their travel day – any month. */
function OpenTickets() {
  const [list, setList] = React.useState<TripRow[] | null>(null);
  const { open, toggle } = useStoredOpen("openTickets", true);
  React.useEffect(() => {
    fetch("/api/trips?status=lifted")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setList(d?.trips ?? []))
      .catch(() => {});
  }, []);
  if (!list?.length) return null;
  const t = todayStr();
  const days = (d: string) => Math.round((Date.parse(`${d}T12:00:00Z`) - Date.parse(`${t}T12:00:00Z`)) / 86_400_000);
  // a round trip's price is for both directions – this ticket is one of them
  const worth = (x: TripRow) => x.ticket?.directionPrice ?? (x.price != null ? (x.roundTrip ? x.price / 2 : x.price) : null);
  const rows = list.map((x) => ({ x, until: liftedUsableUntil(x.date) })).sort((a, b) => a.until.localeCompare(b.until));
  const valid = rows.filter((r) => r.until >= t);
  const expired = rows.filter((r) => r.until < t);
  const sum = valid.reduce((n, r) => n + (worth(r.x) ?? 0), 0);
  // the ticket's own places ("Bochum+City" → "Bochum") read shorter than the first / last stop
  const place = (ticket: string | null | undefined, stop: string) => ticket?.replace(/\+City$/i, "").trim() || stop;
  const row = ({ x, until }: { x: TripRow; until: string }) => {
    const d = days(until);
    const p = worth(x);
    return (
      <Link key={x.id} href={`/reisen/${x.id}`} className="block py-1.5 hover:bg-muted/40">
        <span className="flex items-baseline gap-3">
          <span className="min-w-0 flex-1">{place(x.ticket?.from, x.originName)} → {place(x.ticket?.to, x.destName)}</span>
          {p != null && <span className="tabular-nums">{formatEuro(p)}</span>}
        </span>
        <span className="block text-xs text-muted-foreground">
          Fahrt vom {deDate(x.date)} ·{" "}
          <span className={cn(d >= 0 && d <= 31 && "font-semibold text-warning")}>
            {d < 0 ? `abgelaufen am ${deDate(until)}` : `nutzbar bis ${deDate(until)}${d <= 60 ? ` (noch ${d} T.)` : ""}`}
          </span>
          {x.orderNumber ? ` · Auftrag ${x.orderNumber}` : ""}
        </span>
      </Link>
    );
  };
  return (
    <Card className="p-3 sm:p-4">
      <button className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 text-left text-sm" onClick={toggle}>
        <span className="font-semibold">Offene Tickets</span>
        {valid.length ? (
          <span>
            <b>{formatEuro(sum)}</b> in {valid.length} {valid.length === 1 ? "Ticket" : "Tickets"}
          </span>
        ) : (
          <span className="text-muted-foreground">keine mehr nutzbar</span>
        )}
        <Chevron open={open} className="ml-auto self-center" />
      </button>
      {open && (
        <div className="mt-2 text-sm">
          <div className="divide-y divide-border">{valid.map(row)}</div>
          <p className="mt-2 text-xs text-muted-foreground">
            Zugbindung aufgehoben, noch nicht gefahren: laut DB bis ein Jahr nach dem Reisetag nutzbar, auf der Strecke des Tickets mit
            jedem Zug. Fährst du damit, in der Fahrt „Damit gefahren …“ wählen.
          </p>
          {expired.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-muted-foreground">{expired.length} abgelaufen</summary>
              <div className="divide-y divide-border opacity-60">{expired.map(row)}</div>
            </details>
          )}
        </div>
      )}
    </Card>
  );
}

interface Voucher {
  number: string;
  value: number;
  validUntil: string | null;
  orderNumber: string | null;
  receivedAt: string;
  redeemed: boolean;
  usedOrder?: string | null;
  replacedBy?: string | null;
  autoRedeemed?: boolean;
}
type VoucherQuestion =
  | { kind: "which"; orderNumber: string; date: string; price: number; rest: string; restValue: number; candidates: string[] }
  | { kind: "used"; orderNumber: string; date: string; price: number; voucher: string };
const deDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("de-DE");

/** DB vouchers: from mails (remaining value after paying with a voucher) or entered by hand. */
function Vouchers() {
  const [list, setList] = React.useState<Voucher[]>([]);
  // which voucher paid for which booking — the mails don't say (see lib/trips/voucherUse)
  const [questions, setQuestions] = React.useState<VoucherQuestion[]>([]);
  // order number → trip (links "Rest aus Auftrag …" / "eingesetzt für Auftrag …")
  const [tripOf, setTripOf] = React.useState<Record<string, string>>({});
  const { open, toggle, show } = useStoredOpen("vouchers", false);
  // opened via "Verwalten" in the search's voucher card (runs before the page rewrites the URL)
  React.useEffect(() => {
    if (window.location.hash === "#gutscheine") show();
  }, []);
  // date preset to a year from today; untouched it isn't sent, so a known number keeps its own
  const blank = () => ({ number: "", value: "", validUntil: inOneYear(), dateSet: false });
  const [form, setForm] = React.useState(blank);
  const [err, setErr] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  React.useEffect(() => {
    fetch("/api/vouchers")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setList(d?.vouchers ?? []);
        setQuestions(d?.questions ?? []);
        setTripOf(d?.trips ?? {});
        if (d?.questions?.length) show();
        if (window.location.hash === "#gutscheine")
          requestAnimationFrame(() => document.getElementById("gutscheine")?.scrollIntoView({ block: "start" }));
      })
      .catch(() => {});
  }, []);
  async function post(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    setErr(null);
    setNote(null);
    try {
      const res = await fetch("/api/vouchers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(d.error ?? "Fehler");
        return null;
      }
      setList(d.vouchers ?? []);
      if (d.questions) setQuestions(d.questions);
      return d;
    } catch {
      setErr("Keine Verbindung");
      return null;
    }
  }
  // the last changes, with each voucher as it was before → "Rückgängig"
  const [undo, setUndo] = React.useState<{ before: Voucher[]; texts: Record<string, string> } | null>(null);
  async function change(body: Record<string, unknown>, text: string) {
    const was = list.find((v) => v.number === body.number);
    if (!(await post(body)) || !was) return;
    setUndo((u) => ({
      // the first state of a voucher counts (ticked twice → back to the start)
      before: [...(u?.before ?? []), ...(u?.before.some((v) => v.number === was.number) ? [] : [was])],
      // per voucher only what it is now (ticked and unticked again → "wieder offen")
      texts: { ...u?.texts, [was.number]: text },
    }));
  }
  async function revert() {
    const u = undo;
    setUndo(null);
    for (const v of u?.before ?? []) await post({ action: "restore", number: v.number, state: v });
  }
  // ticked while the toast shows: stays where it was, so the next one doesn't slide under the finger
  const held = new Set((undo?.before ?? []).filter((v) => !v.redeemed).map((v) => v.number));
  const t = todayStr();
  const openOnes = list
    .filter((v) => (!v.redeemed || held.has(v.number)) && (!v.validUntil || v.validUntil >= t))
    .sort((a, b) => b.value - a.value || a.number.localeCompare(b.number));
  const done = list.filter((v) => !openOnes.includes(v)).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const stillOpen = openOnes.filter((v) => !v.redeemed);
  const sum = stillOpen.reduce((x, v) => x + (v.value ?? 0), 0);
  const typed = form.number.trim().toUpperCase().replace(/\s+/g, "");
  const known = typed.length >= 5 ? list.find((v) => v.number === typed) : undefined;
  const orderLink = (o: string) =>
    tripOf[o] ? (
      <Link href={`/reisen/${tripOf[o]}`} className="text-primary underline">
        {o}
      </Link>
    ) : (
      o
    );
  const row = (v: Voucher) => (
    <div key={v.number} className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5", v.redeemed && "opacity-50")}>
      <CopyCode code={v.number} />
      <Input
        key={`${v.number}-${v.value}`}
        className="h-7 w-24 text-right"
        inputMode="decimal"
        placeholder="?"
        defaultValue={v.value != null ? v.value.toFixed(2).replace(".", ",") : ""}
        onBlur={(e) => {
          const raw = e.target.value.trim();
          const n = Number(raw.replace(",", "."));
          // empty or not a number → back to the stored amount, never 0 €
          if (!raw || !Number.isFinite(n) || n < 0) e.target.value = v.value != null ? v.value.toFixed(2).replace(".", ",") : "";
          else if (n !== v.value) post({ action: "update", number: v.number, value: n });
        }}
        aria-label="Betrag"
      />
      €
      <span className="text-xs text-muted-foreground">
        {v.validUntil ? `gültig bis ${new Date(`${v.validUntil}T12:00:00Z`).toLocaleDateString("de-DE")}` : "Gültigkeit unbekannt"}
        {v.orderNumber && <> · Rest aus Auftrag {orderLink(v.orderNumber)}</>}
        {v.usedOrder && <> · eingesetzt für Auftrag {orderLink(v.usedOrder)}</>}
        {v.replacedBy ? ` · Rest jetzt in ${v.replacedBy}` : ""}
        {v.autoRedeemed ? " · automatisch erkannt" : ""}
      </span>
      <label className="ml-auto flex items-center gap-1 text-xs">
        <input
          type="checkbox"
          checked={v.redeemed}
          onChange={() => change({ action: "update", number: v.number, redeemed: !v.redeemed }, `${v.number} ${v.redeemed ? "wieder offen" : "als eingelöst markiert"}`)}
        />{" "}
        eingelöst
      </label>
    </div>
  );
  return (
    <Card id="gutscheine" className="scroll-mt-20 p-3 sm:p-4">
      <button className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 text-left text-sm" onClick={toggle}>
        <span className="font-semibold">Gutscheine</span>
        {stillOpen.length ? (
          <span>
            <b>{formatEuro(sum)}</b> offen in {stillOpen.length} {stillOpen.length === 1 ? "Gutschein" : "Gutscheinen"}
          </span>
        ) : (
          <span className="text-muted-foreground">keine offenen</span>
        )}
        <Chevron open={open} className="ml-auto self-center" />
      </button>
      {open && (
        <div className="mt-2 text-sm">
          {questions.map((q) => (
            <div key={`${q.kind}-${q.orderNumber}`} className="mb-2 rounded-xl border border-warning/40 bg-warning/5 p-2.5">
              {q.kind === "which" ? (
                <>
                  <p>
                    Für die Buchung vom {deDate(q.date)} ({formatEuro(q.price)}, Auftrag {orderLink(q.orderNumber)}) kam ein Rest-Gutschein über{" "}
                    {formatEuro(q.restValue)}. Welcher Gutschein wurde eingesetzt?
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {q.candidates.map((c) => (
                      <Button key={c} size="sm" variant="outline" className="font-mono" onClick={() => change({ action: "used", number: c, order: q.orderNumber, replacedBy: q.rest }, `${c} als eingelöst markiert`)}>
                        {c}
                      </Button>
                    ))}
                    <Button size="sm" variant="ghost" onClick={() => change({ action: "resolve", number: q.rest }, "Gemerkt: keiner davon")}>
                      keiner davon
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <p>
                    Die Buchung vom {deDate(q.date)} (Auftrag {orderLink(q.orderNumber)}) kostete genau {formatEuro(q.price)} – so viel wie Gutschein{" "}
                    <span className="font-mono">{q.voucher}</span>. Damit bezahlt?
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <Button size="sm" variant="outline" onClick={() => change({ action: "used", number: q.voucher, order: q.orderNumber }, `${q.voucher} als eingelöst markiert`)}>
                      Ja, eingelöst
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => change({ action: "notUsed", number: q.voucher, order: q.orderNumber }, `Gemerkt: nicht mit ${q.voucher} bezahlt`)}>
                      Nein
                    </Button>
                  </div>
                </>
              )}
            </div>
          ))}
          <div className="divide-y divide-border">{openOnes.map(row)}</div>
          <div className="mt-2 flex flex-wrap items-end gap-2 border-t border-border pt-2">
            <Input
              className="h-8 w-32 font-mono"
              placeholder="Nummer"
              value={form.number}
              onChange={(e) => setForm({ ...form, number: e.target.value })}
            />
            <Input
              className="h-8 w-24"
              inputMode="decimal"
              placeholder={known ? (known.value ?? 0).toFixed(2).replace(".", ",") : "Betrag €"}
              value={form.value}
              onChange={(e) => setForm({ ...form, value: e.target.value })}
            />
            <Input
              className="h-8 w-36"
              type="date"
              value={form.dateSet || !known?.validUntil ? form.validUntil : known.validUntil}
              onChange={(e) => setForm({ ...form, validUntil: e.target.value, dateSet: true })}
              aria-label="gültig bis"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                const raw = form.value.trim();
                const value = Number(raw.replace(",", "."));
                if (!form.number.trim()) return setErr("Nummer eintragen.");
                if (raw && (!Number.isFinite(value) || value <= 0)) return setErr("Betrag ungültig.");
                const d = await post({
                  action: "add",
                  number: form.number,
                  ...(raw ? { value } : {}),
                  ...(form.dateSet || !known ? { validUntil: form.validUntil || null } : {}),
                });
                if (!d) return;
                setForm(blank());
                if (d.restored) setNote(`${form.number.trim().toUpperCase()} ist wieder offen – Betrag und Gültigkeit wie zuvor.`);
              }}
            >
              {known?.redeemed ? "Wieder aktivieren" : "Hinzufügen"}
            </Button>
          </div>
          {known && !err && (
            <p className="mt-1 text-xs text-muted-foreground">
              {known.redeemed
                ? `Bekannt: ${formatEuro(known.value ?? 0)}${known.validUntil ? `, gültig bis ${deDate(known.validUntil)}` : ""}${
                    known.usedOrder ? `, war für Auftrag ${known.usedOrder} abgehakt` : ", war abgehakt"
                  }. Die Nummer reicht – er wird wieder als offen geführt.`
                : `Schon offen in der Liste (${formatEuro(known.value ?? 0)}).`}
            </p>
          )}
          {note && <p className="mt-1 text-xs text-success">{note}</p>}
          {err && <p className="mt-1 text-xs text-danger">{err}</p>}
          <p className="mt-2 text-xs text-muted-foreground">
            Zahlst du mit einem Gutschein, stellt die DB für den Rest einen neuen aus (kommt per Mail). Welcher alte damit weg ist,
            rechnet die App aus (alter Wert = Preis + Rest) und hakt ihn ab; passen mehrere, fragt sie nach.
          </p>
          {done.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-muted-foreground">{done.length} eingelöst / abgelaufen</summary>
              <div className="divide-y divide-border">{done.map(row)}</div>
            </details>
          )}
        </div>
      )}
      {undo && (
        <Toast
          text={Object.values(undo.texts).join(" · ")}
          action="Rückgängig"
          onAction={revert}
          onClose={() => setUndo(null)}
        />
      )}
    </Card>
  );
}
